// Merlin transcript (STROBE-128 over Keccak-f[1600]), used by the CometBFT
// secret-connection handshake to derive the authentication challenge.
// Spec: https://merlin.cool and https://strobe.sourceforge.io/specs/

const ROT = [
	[0, 36, 3, 41, 18],
	[1, 44, 10, 45, 2],
	[62, 6, 43, 15, 61],
	[28, 55, 25, 21, 56],
	[27, 20, 39, 8, 14],
];

const RC = [
	0x0000000000000001n,
	0x0000000000008082n,
	0x800000000000808an,
	0x8000000080008000n,
	0x000000000000808bn,
	0x0000000080000001n,
	0x8000000080008081n,
	0x8000000000008009n,
	0x000000000000008an,
	0x0000000000000088n,
	0x0000000080008009n,
	0x000000008000000an,
	0x000000008000808bn,
	0x800000000000008bn,
	0x8000000000008089n,
	0x8000000000008003n,
	0x8000000000008002n,
	0x8000000000000080n,
	0x000000000000800an,
	0x800000008000000an,
	0x8000000080008081n,
	0x8000000000008080n,
	0x0000000080000001n,
	0x8000000080008008n,
];

const MASK = (1n << 64n) - 1n;

function rotl(x: bigint, n: number): bigint {
	if (n === 0) return x & MASK;
	const s = BigInt(n);
	return ((x << s) | (x >> (64n - s))) & MASK;
}

export function keccakF1600(state: bigint[]): void {
	for (let round = 0; round < 24; round++) {
		const c = new Array<bigint>(5);
		for (let x = 0; x < 5; x++) {
			c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
		}
		for (let x = 0; x < 5; x++) {
			const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
			for (let y = 0; y < 25; y += 5) state[y + x] ^= d;
		}

		const b = new Array<bigint>(25).fill(0n);
		for (let x = 0; x < 5; x++) {
			for (let y = 0; y < 5; y++) {
				b[y + ((2 * x + 3 * y) % 5) * 5] = rotl(state[x + 5 * y], ROT[x][y]);
			}
		}
		for (let y = 0; y < 25; y += 5) {
			for (let x = 0; x < 5; x++) {
				state[y + x] = b[y + x] ^ (~b[y + ((x + 1) % 5)] & MASK & b[y + ((x + 2) % 5)]);
			}
		}
		state[0] ^= RC[round];
	}
}

function permuteBytes(state: Uint8Array): void {
	const lanes = new Array<bigint>(25);
	for (let i = 0; i < 25; i++) {
		let lane = 0n;
		for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(state[i * 8 + b]);
		lanes[i] = lane;
	}
	keccakF1600(lanes);
	for (let i = 0; i < 25; i++) {
		let lane = lanes[i];
		for (let b = 0; b < 8; b++) {
			state[i * 8 + b] = Number(lane & 0xffn);
			lane >>= 8n;
		}
	}
}

const STROBE_R = 166;
const FLAG = { I: 1, A: 2, C: 4, T: 8, M: 16, K: 32 } as const;

const encoder = new TextEncoder();

function toBytes(data: string | Uint8Array): Uint8Array {
	return typeof data === 'string' ? encoder.encode(data) : data;
}

function le32(n: number): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, n, true);
	return out;
}

class Strobe128 {
	private state = new Uint8Array(200);
	private pos = 0;
	private posBegin = 0;
	private curFlags = 0;

	constructor(protocolLabel: string) {
		this.state.set([1, STROBE_R + 2, 1, 0, 1, 96], 0);
		this.state.set(encoder.encode('STROBEv1.0.2'), 6);
		permuteBytes(this.state);
		this.metaAD(protocolLabel, false);
	}

	private runF(): void {
		this.state[this.pos] ^= this.posBegin;
		this.state[this.pos + 1] ^= 0x04;
		this.state[STROBE_R + 1] ^= 0x80;
		permuteBytes(this.state);
		this.pos = 0;
		this.posBegin = 0;
	}

	private absorb(data: Uint8Array): void {
		for (const byte of data) {
			this.state[this.pos++] ^= byte;
			if (this.pos === STROBE_R) this.runF();
		}
	}

	private squeeze(len: number): Uint8Array {
		const out = new Uint8Array(len);
		for (let i = 0; i < len; i++) {
			out[i] = this.state[this.pos];
			this.state[this.pos++] = 0;
			if (this.pos === STROBE_R) this.runF();
		}
		return out;
	}

	private beginOp(flags: number, more: boolean): void {
		if (more) {
			if (this.curFlags !== flags) throw new Error('strobe: continued op flags changed');
			return;
		}
		if (flags & FLAG.T) throw new Error('strobe: T flag unsupported');
		const oldBegin = this.posBegin;
		this.posBegin = this.pos + 1;
		this.curFlags = flags;
		this.absorb(new Uint8Array([oldBegin, flags]));
		if ((flags & (FLAG.C | FLAG.K)) !== 0 && this.pos !== 0) this.runF();
	}

	metaAD(data: string | Uint8Array, more: boolean): void {
		this.beginOp(FLAG.M | FLAG.A, more);
		this.absorb(toBytes(data));
	}

	AD(data: string | Uint8Array, more: boolean): void {
		this.beginOp(FLAG.A, more);
		this.absorb(toBytes(data));
	}

	PRF(len: number, more: boolean): Uint8Array {
		this.beginOp(FLAG.I | FLAG.A | FLAG.C, more);
		return this.squeeze(len);
	}
}

export class Merlin {
	private strobe: Strobe128;

	constructor(label: string) {
		this.strobe = new Strobe128('Merlin v1.0');
		this.appendMessage('dom-sep', label);
	}

	appendMessage(label: string, message: string | Uint8Array): void {
		const msg = toBytes(message);
		this.strobe.metaAD(label, false);
		this.strobe.metaAD(le32(msg.length), true);
		this.strobe.AD(msg, false);
	}

	challengeBytes(label: string, len: number): Uint8Array {
		this.strobe.metaAD(label, false);
		this.strobe.metaAD(le32(len), true);
		return this.strobe.PRF(len, false);
	}
}
