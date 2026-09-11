import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Merlin } from '../src/p2p/merlin';
import { fieldBytes, fieldString, fieldVarint } from '../src/p2p/protobuf';
import { dialSecretConnection } from '../src/p2p/secretConnection';
import {
	_test_buildNodeInfo,
	_test_decodeAddrs,
	_test_decodePacket,
	_test_encodePacketMsg,
	_test_parseNodeInfo,
	parseSeed,
	versionUsesPexWrapper,
} from '../src/p2p/tendermintPex';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

describe('Merlin transcript', () => {
	it('matches the CometBFT secret-connection challenge vector', () => {
		// Vector generated with github.com/oasisprotocol/curve25519-voi merlin.
		const transcript = new Merlin('TENDERMINT_SECRET_CONNECTION_TRANSCRIPT_HASH');
		const range = (start: number): Uint8Array =>
			Uint8Array.from({ length: 32 }, (_, i) => start + i);
		transcript.appendMessage('EPHEMERAL_LOWER_PUBLIC_KEY', range(0));
		transcript.appendMessage('EPHEMERAL_UPPER_PUBLIC_KEY', range(32));
		transcript.appendMessage('DH_SECRET', range(64));
		expect(hex(transcript.challengeBytes('SECRET_CONNECTION_MAC', 32))).toBe(
			'e98c5f27783951ea05ba98fe7ec2cf3d8e90a2d8ee5bb3647a624c889b751a8a'
		);
	});
});

describe('PEX protobuf', () => {
	const netAddress = (id: string, ip: string, port: number): Uint8Array =>
		new Uint8Array([...fieldString(1, id), ...fieldString(2, ip), ...fieldVarint(3, port)]);
	const pexAddrs = (): Uint8Array =>
		new Uint8Array([
			...fieldBytes(1, netAddress('node1', '1.2.3.4', 26656)),
			...fieldBytes(1, netAddress('node2', '5.6.7.8', 26657)),
		]);

	it('decodes wrapped v0.38 PexAddrs', () => {
		const wrapped = fieldBytes(2, pexAddrs());
		expect(_test_decodeAddrs(wrapped, true)).toEqual([
			{ id: 'node1', ip: '1.2.3.4', port: 26656 },
			{ id: 'node2', ip: '5.6.7.8', port: 26657 },
		]);
	});

	it('decodes bare pre-v0.38 PexAddrs', () => {
		expect(_test_decodeAddrs(pexAddrs(), false)).toHaveLength(2);
	});

	it('round-trips an MConnection PacketMsg', () => {
		const data = new Uint8Array([1, 2, 3]);
		const packet = _test_encodePacketMsg(0, data);
		expect(_test_decodePacket(packet)).toMatchObject({
			kind: 'msg',
			channel: 0,
			eof: true,
			data,
		});
	});

	it('round-trips the NodeInfo handshake', () => {
		const parsed = _test_parseNodeInfo(_test_buildNodeInfo('abc123', 'osmosis-1', '0.38.23'));
		expect(parsed.network).toBe('osmosis-1');
		expect(parsed.id).toBe('abc123');
		expect(parsed.version).toBe('0.38.23');
		expect(parsed.blockVersion).toBe(11);
		expect([...parsed.channels]).toContain(0x00);
	});
});

describe('PEX seed/version helpers', () => {
	it('parses id@host:port seeds', () => {
		expect(parseSeed('ABCDEF@1.2.3.4:26656')).toEqual({
			id: 'abcdef',
			host: '1.2.3.4',
			port: 26656,
		});
		expect(parseSeed('1.2.3.4:26656')).toBeNull();
		expect(parseSeed('abc@host:99999')).toBeNull();
	});

	it('selects the PEX wrapper by peer version', () => {
		expect(versionUsesPexWrapper('0.38.23')).toBe(true);
		expect(versionUsesPexWrapper('0.37.11')).toBe(false);
		expect(versionUsesPexWrapper('0.34.24')).toBe(false);
		expect(versionUsesPexWrapper('1.0.0')).toBe(true);
	});
});

describe('secret connection handshake', () => {
	const servers: net.Server[] = [];

	afterEach(() => {
		for (const server of servers.splice(0)) server.close();
	});

	it('authenticates both peers and exchanges NodeInfo over loopback', async () => {
		const server = net.createServer();
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const address = server.address() as net.AddressInfo;

		const serverSocket = new Promise<net.Socket>((resolve) => server.once('connection', resolve));
		const serverDial = serverSocket.then((socket) => dialSecretConnection(socket, 3000));
		const clientDial = new Promise<net.Socket>((resolve, reject) => {
			const socket = net.connect({ host: '127.0.0.1', port: address.port });
			socket.once('connect', () => resolve(socket));
			socket.once('error', reject);
		}).then((socket) => dialSecretConnection(socket, 3000));

		const [client, serverConn] = await Promise.all([clientDial, serverDial]);
		expect(client.peerId).toBe(serverConn.localId);
		expect(serverConn.peerId).toBe(client.localId);

		client.connection.writeDelimited(_test_buildNodeInfo(client.localId, 'test-chain', '0.38.23'));
		serverConn.connection.writeDelimited(
			_test_buildNodeInfo(serverConn.localId, 'test-chain', '0.38.23')
		);
		const [peerSeenByClient, peerSeenByServer] = await Promise.all([
			client.connection.readDelimited(),
			serverConn.connection.readDelimited(),
		]);
		expect(_test_parseNodeInfo(peerSeenByClient).network).toBe('test-chain');
		expect(_test_parseNodeInfo(peerSeenByServer).id).toBe(client.localId);

		client.connection.close();
		serverConn.connection.close();
	});
});
