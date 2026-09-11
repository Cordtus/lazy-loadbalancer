// CometBFT secret connection (station-to-station) + authenticated-encryption
// framing. Port of p2p/conn/secret_connection.go.
import crypto from 'node:crypto';
import type net from 'node:net';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { Merlin } from './merlin.ts';
import { concat, delimited, fieldBytes, firstBytes, readFields } from './protobuf.ts';

const DATA_MAX = 1024;
const DATA_LEN = 4;
const FRAME_SIZE = DATA_MAX + DATA_LEN;
const TAG_SIZE = 16;
const SEALED_SIZE = FRAME_SIZE + TAG_SIZE;

const LABEL_EPHEMERAL_LOWER = 'EPHEMERAL_LOWER_PUBLIC_KEY';
const LABEL_EPHEMERAL_UPPER = 'EPHEMERAL_UPPER_PUBLIC_KEY';
const LABEL_DH_SECRET = 'DH_SECRET';
const LABEL_CONNECTION_MAC = 'SECRET_CONNECTION_MAC';
const KEY_AND_CHALLENGE_INFO = new TextEncoder().encode(
	'TENDERMINT_SECRET_CONNECTION_KEY_AND_CHALLENGE_GEN'
);

const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');

function incrNonce(nonce: Buffer): void {
	const counter = nonce.readBigUInt64LE(4) + 1n;
	nonce.writeBigUInt64LE(counter, 4);
}

function seal(plain: Uint8Array, key: Uint8Array, nonce: Uint8Array): Uint8Array {
	return chacha20poly1305(key, nonce).encrypt(plain);
}

function open(sealed: Uint8Array, key: Uint8Array, nonce: Uint8Array): Uint8Array {
	return chacha20poly1305(key, nonce).decrypt(sealed);
}

function rawX25519Public(key: crypto.KeyObject): Buffer {
	return key.export({ type: 'spki', format: 'der' }).subarray(-32) as Buffer;
}

function x25519PublicFromRaw(raw: Uint8Array): crypto.KeyObject {
	return crypto.createPublicKey({
		key: Buffer.concat([X25519_SPKI, Buffer.from(raw)]),
		format: 'der',
		type: 'spki',
	});
}

export function ed25519RawPublic(key: crypto.KeyObject): Buffer {
	return key.export({ type: 'spki', format: 'der' }).subarray(-32) as Buffer;
}

export function ed25519PublicFromRaw(raw: Uint8Array): crypto.KeyObject {
	return crypto.createPublicKey({
		key: Buffer.concat([ED25519_SPKI, Buffer.from(raw)]),
		format: 'der',
		type: 'spki',
	});
}

export function peerIdFromRawPublic(raw: Uint8Array): string {
	return crypto.createHash('sha256').update(raw).digest().subarray(0, 20).toString('hex');
}

class BufferedSocket {
	private buf = Buffer.alloc(0);
	private waiters: Array<() => void> = [];
	private closed = false;
	private err: Error | null = null;

	constructor(private socket: net.Socket) {
		socket.on('data', (data: Buffer) => {
			this.buf = Buffer.concat([this.buf, data]);
			this.wake();
		});
		socket.on('error', (err: Error) => {
			this.err = err;
			this.closed = true;
			this.wake();
		});
		socket.on('close', () => {
			this.closed = true;
			this.wake();
		});
	}

	private wake(): void {
		const waiters = this.waiters;
		this.waiters = [];
		for (const resolve of waiters) resolve();
	}

	async readExactly(n: number): Promise<Buffer> {
		while (this.buf.length < n) {
			if (this.err) throw this.err;
			if (this.closed) throw new Error('P2P connection closed');
			await new Promise<void>((resolve) => this.waiters.push(resolve));
		}
		const out = this.buf.subarray(0, n);
		this.buf = this.buf.subarray(n);
		return out;
	}

	write(data: Uint8Array): void {
		this.socket.write(data);
	}

	close(): void {
		this.socket.destroy();
	}
}

export class SecretConnection {
	private recvPlain = Buffer.alloc(0);
	private sendNonce = Buffer.alloc(12);
	private recvNonce = Buffer.alloc(12);

	constructor(
		private sock: BufferedSocket,
		private sendKey: Uint8Array,
		private recvKey: Uint8Array
	) {}

	write(data: Uint8Array): void {
		let offset = 0;
		do {
			const chunk = data.subarray(offset, Math.min(offset + DATA_MAX, data.length));
			offset += chunk.length;
			const frame = Buffer.alloc(FRAME_SIZE);
			frame.writeUInt32LE(chunk.length, 0);
			frame.set(chunk, DATA_LEN);
			this.sock.write(seal(frame, this.sendKey, this.sendNonce));
			incrNonce(this.sendNonce);
		} while (offset < data.length);
	}

	writeDelimited(message: Uint8Array): void {
		this.write(delimited(message));
	}

	async readExactly(n: number): Promise<Buffer> {
		while (this.recvPlain.length < n) {
			const sealed = await this.sock.readExactly(SEALED_SIZE);
			const frame = open(sealed, this.recvKey, this.recvNonce);
			incrNonce(this.recvNonce);
			const len = Buffer.from(frame).readUInt32LE(0);
			if (len > DATA_MAX) throw new Error('P2P frame too large');
			this.recvPlain = Buffer.concat([
				this.recvPlain,
				Buffer.from(frame.subarray(DATA_LEN, DATA_LEN + len)),
			]);
		}
		const out = this.recvPlain.subarray(0, n);
		this.recvPlain = this.recvPlain.subarray(n);
		return out;
	}

	async readVarint(): Promise<number> {
		let result = 0;
		let shift = 0;
		for (;;) {
			const byte = (await this.readExactly(1))[0];
			result |= (byte & 0x7f) << shift;
			if ((byte & 0x80) === 0) return result >>> 0;
			shift += 7;
			if (shift > 28) throw new Error('P2P varint too long');
		}
	}

	async readDelimited(): Promise<Buffer> {
		const len = await this.readVarint();
		return this.readExactly(len);
	}

	close(): void {
		this.sock.close();
	}
}

export interface SecretConnectionResult {
	connection: SecretConnection;
	peerPublicKey: Buffer;
	peerId: string;
	localId: string;
}

export async function dialSecretConnection(
	socket: net.Socket,
	timeoutMs: number
): Promise<SecretConnectionResult> {
	const sock = new BufferedSocket(socket);

	socket.setTimeout(timeoutMs, () => socket.destroy(new Error('P2P handshake timeout')));

	// Ephemeral X25519 key exchange (plaintext, delimited BytesValue).
	const ephemeral = crypto.generateKeyPairSync('x25519');
	const localEphPub = rawX25519Public(ephemeral.publicKey);
	sock.write(delimited(fieldBytes(1, localEphPub)));
	const remoteEphPub = firstBytes(readFields(await readRawDelimited(sock)), 1);
	if (!remoteEphPub || remoteEphPub.length !== 32) {
		throw new Error('P2P: invalid ephemeral public key');
	}

	const localIsLeast = Buffer.compare(localEphPub, Buffer.from(remoteEphPub)) < 0;
	const lo = localIsLeast ? localEphPub : Buffer.from(remoteEphPub);
	const hi = localIsLeast ? Buffer.from(remoteEphPub) : localEphPub;

	const dhSecret = Buffer.from(
		crypto.diffieHellman({
			privateKey: ephemeral.privateKey,
			publicKey: x25519PublicFromRaw(remoteEphPub),
		})
	);

	const transcript = new Merlin('TENDERMINT_SECRET_CONNECTION_TRANSCRIPT_HASH');
	transcript.appendMessage(LABEL_EPHEMERAL_LOWER, lo);
	transcript.appendMessage(LABEL_EPHEMERAL_UPPER, hi);
	transcript.appendMessage(LABEL_DH_SECRET, dhSecret);
	const challenge = transcript.challengeBytes(LABEL_CONNECTION_MAC, 32);

	const derived = Buffer.from(
		crypto.hkdfSync('sha256', dhSecret, Buffer.alloc(32), KEY_AND_CHALLENGE_INFO, 96)
	);
	const firstKey = derived.subarray(0, 32);
	const secondKey = derived.subarray(32, 64);
	const recvKey = localIsLeast ? firstKey : secondKey;
	const sendKey = localIsLeast ? secondKey : firstKey;

	const connection = new SecretConnection(sock, sendKey, recvKey);

	// Persistent Ed25519 identity + challenge signature exchange.
	const identity = crypto.generateKeyPairSync('ed25519');
	const localPub = ed25519RawPublic(identity.publicKey);
	const signature = crypto.sign(null, Buffer.from(challenge), identity.privateKey);
	const pubKeyProto = fieldBytes(1, localPub);
	const authSigMessage = concat([fieldBytes(1, pubKeyProto), fieldBytes(2, signature)]);
	connection.writeDelimited(authSigMessage);

	const remoteAuth = readFields(await connection.readDelimited());
	const remotePubKey = firstBytes(remoteAuth, 1);
	const remotePubRaw = remotePubKey ? firstBytes(readFields(remotePubKey), 1) : undefined;
	const remoteSignature = firstBytes(remoteAuth, 2);
	if (!remotePubRaw || !remoteSignature || remotePubRaw.length !== 32) {
		throw new Error('P2P: invalid auth signature message');
	}
	const verified = crypto.verify(
		null,
		Buffer.from(challenge),
		ed25519PublicFromRaw(remotePubRaw),
		Buffer.from(remoteSignature)
	);
	if (!verified) throw new Error('P2P: challenge signature verification failed');

	return {
		connection,
		peerPublicKey: Buffer.from(remotePubRaw),
		peerId: peerIdFromRawPublic(remotePubRaw),
		localId: peerIdFromRawPublic(localPub),
	};
}

async function readRawDelimited(sock: BufferedSocket): Promise<Uint8Array> {
	let result = 0;
	let shift = 0;
	for (;;) {
		const byte = (await sock.readExactly(1))[0];
		result |= (byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) break;
		shift += 7;
		if (shift > 28) throw new Error('P2P varint too long');
	}
	return sock.readExactly(result >>> 0);
}
