// Native CometBFT P2P client: handshake + PEX peer exchange.
import net from 'node:net';
import {
	allBytes,
	concat,
	delimited,
	fieldBytes,
	fieldString,
	fieldVarint,
	firstBytes,
	firstVarint,
	readFields,
} from './protobuf.ts';
import { type SecretConnection, dialSecretConnection } from './secretConnection.ts';

const PEX_CHANNEL = 0x00;
const EMPTY = new Uint8Array(0);

export interface PexSeed {
	id: string;
	host: string;
	port: number;
}

export interface DiscoveredPeer {
	id: string;
	ip: string;
	port: number;
}

export interface PeerNodeInfo {
	id: string;
	listenAddr: string;
	network: string;
	version: string;
	channels: Uint8Array;
	moniker: string;
	blockVersion: number;
}

export function parseSeed(seed: string): PexSeed | null {
	const at = seed.lastIndexOf('@');
	if (at <= 0) return null;
	const id = seed.slice(0, at).trim().toLowerCase();
	const hostPort = seed.slice(at + 1);
	const colon = hostPort.lastIndexOf(':');
	if (colon <= 0) return null;
	const host = hostPort.slice(0, colon);
	const port = Number.parseInt(hostPort.slice(colon + 1), 10);
	if (!id || !host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
	return { id, host, port };
}

function connectSocket(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host, port });
		socket.setTimeout(timeoutMs, () => socket.destroy(new Error('P2P connect timeout')));
		const onError = (err: Error) => {
			socket.destroy();
			reject(err);
		};
		socket.once('error', onError);
		socket.once('connect', () => {
			socket.removeListener('error', onError);
			resolve(socket);
		});
	});
}

function buildNodeInfo(id: string, network: string, version: string): Uint8Array {
	const protocolVersion = concat([
		fieldVarint(1, 8), // p2p
		fieldVarint(2, 11), // block
	]);
	const other = concat([fieldString(1, 'off'), fieldString(2, 'tcp://0.0.0.0:26657')]);
	return concat([
		fieldBytes(1, protocolVersion),
		fieldString(2, id),
		fieldString(3, 'tcp://0.0.0.0:26656'),
		fieldString(4, network),
		fieldString(5, version),
		fieldBytes(6, new Uint8Array([PEX_CHANNEL])),
		fieldString(7, 'lazy-lb-pex'),
		fieldBytes(8, other),
	]);
}

export function parseNodeInfo(buf: Uint8Array): PeerNodeInfo {
	const fields = readFields(buf);
	const protocol = firstBytes(fields, 1);
	const blockVersion = protocol ? Number(firstVarint(readFields(protocol), 2) ?? 0n) : 0;
	const decoder = new TextDecoder();
	const str = (field: number): string => {
		const bytes = firstBytes(fields, field);
		return bytes ? decoder.decode(bytes) : '';
	};
	return {
		id: str(2),
		listenAddr: str(3),
		network: str(4),
		version: str(5),
		channels: firstBytes(fields, 6) ?? EMPTY,
		moniker: str(7),
		blockVersion,
	};
}

function encodePacketMsg(channel: number, data: Uint8Array): Uint8Array {
	const parts: Uint8Array[] = [];
	if (channel !== 0) parts.push(fieldVarint(1, channel));
	parts.push(fieldVarint(2, 1)); // eof
	parts.push(fieldBytes(3, data));
	return concat([fieldBytes(3, concat(parts))]);
}

const PONG_PACKET = fieldBytes(2, EMPTY);

interface DecodedPacket {
	kind: 'ping' | 'pong' | 'msg';
	channel: number;
	data: Uint8Array;
	eof: boolean;
}

function decodePacket(buf: Uint8Array): DecodedPacket {
	const fields = readFields(buf);
	if (firstBytes(fields, 1)) return { kind: 'ping', channel: -1, data: EMPTY, eof: false };
	if (firstBytes(fields, 2)) return { kind: 'pong', channel: -1, data: EMPTY, eof: false };
	const msg = firstBytes(fields, 3);
	if (!msg) return { kind: 'msg', channel: -1, data: EMPTY, eof: false };
	const msgFields = readFields(msg);
	return {
		kind: 'msg',
		channel: Number(firstVarint(msgFields, 1) ?? 0n),
		eof: (firstVarint(msgFields, 2) ?? 0n) === 1n,
		data: firstBytes(msgFields, 3) ?? EMPTY,
	};
}

function decodeAddrs(data: Uint8Array, wrapped: boolean): DiscoveredPeer[] {
	let addrsBytes = data;
	if (wrapped) {
		const wrapper = readFields(data);
		addrsBytes = firstBytes(wrapper, 2) ?? EMPTY;
		if (addrsBytes.length === 0) return [];
	}
	const decoder = new TextDecoder();
	return allBytes(readFields(addrsBytes), 1)
		.map((addr) => {
			const fields = readFields(addr);
			const idBytes = firstBytes(fields, 1);
			const ipBytes = firstBytes(fields, 2);
			return {
				id: idBytes ? decoder.decode(idBytes) : '',
				ip: ipBytes ? decoder.decode(ipBytes) : '',
				port: Number(firstVarint(fields, 3) ?? 0n),
			};
		})
		.filter((peer) => peer.ip && peer.port > 0);
}

// The `Message` oneof wrapper around PEX messages was introduced in CometBFT
// v0.38; Tendermint v0.34 / CometBFT v0.37 send the bare messages.
export function versionUsesPexWrapper(version: string): boolean {
	const match = /^(\d+)\.(\d+)/.exec(version.trim());
	if (!match) return true;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > 0 || minor >= 38;
}

export class TendermintPeer {
	private constructor(
		private connection: SecretConnection,
		readonly nodeInfo: PeerNodeInfo,
		readonly peerId: string,
		private wrapped: boolean
	) {}

	static async dial(seed: PexSeed, network: string, timeoutMs: number): Promise<TendermintPeer> {
		const socket = await connectSocket(seed.host, seed.port, timeoutMs);
		const { connection, peerId, localId } = await dialSecretConnection(socket, timeoutMs);

		connection.writeDelimited(buildNodeInfo(localId, network, '0.38.23'));
		const nodeInfo = parseNodeInfo(await connection.readDelimited());

		if (nodeInfo.network !== network) {
			connection.close();
			throw new Error(`PEX peer network mismatch: ${nodeInfo.network} != ${network}`);
		}
		if (!nodeInfo.channels.includes(PEX_CHANNEL)) {
			connection.close();
			throw new Error('PEX peer does not advertise the PEX channel');
		}
		if (seed.id && peerId !== seed.id) {
			connection.close();
			throw new Error(`PEX peer ID mismatch: ${peerId} != ${seed.id}`);
		}

		return new TendermintPeer(
			connection,
			nodeInfo,
			peerId,
			versionUsesPexWrapper(nodeInfo.version)
		);
	}

	async requestPeers(): Promise<DiscoveredPeer[]> {
		const request = this.wrapped ? fieldBytes(1, EMPTY) : EMPTY;
		this.connection.writeDelimited(encodePacketMsg(PEX_CHANNEL, request));

		let buffered = EMPTY;
		while (true) {
			const packet = decodePacket(await this.connection.readDelimited());
			if (packet.kind === 'ping') {
				this.connection.writeDelimited(PONG_PACKET);
				continue;
			}
			if (packet.kind !== 'msg' || packet.channel !== PEX_CHANNEL) continue;
			buffered = concat([buffered, packet.data]);
			if (packet.eof) return decodeAddrs(buffered, this.wrapped);
		}
	}

	close(): void {
		this.connection.close();
	}
}

export const _test_buildNodeInfo = buildNodeInfo;
export const _test_parseNodeInfo = parseNodeInfo;
export const _test_decodeAddrs = decodeAddrs;
export const _test_decodePacket = decodePacket;
export const _test_encodePacketMsg = encodePacketMsg;
