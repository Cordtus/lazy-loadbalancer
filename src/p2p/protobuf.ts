// Minimal protobuf wire helpers for the handful of CometBFT p2p messages we
// speak. Only varint/length-delimited fields are needed.

export function concat(parts: Uint8Array[]): Uint8Array {
	let len = 0;
	for (const p of parts) len += p.length;
	const out = new Uint8Array(len);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

export function varint(n: number | bigint): Uint8Array {
	let value = typeof n === 'bigint' ? n : BigInt(n);
	const out: number[] = [];
	do {
		let byte = Number(value & 0x7fn);
		value >>= 7n;
		if (value > 0n) byte |= 0x80;
		out.push(byte);
	} while (value > 0n);
	return Uint8Array.from(out);
}

function tag(field: number, wire: number): Uint8Array {
	return varint((field << 3) | wire);
}

export function fieldVarint(field: number, value: number | bigint): Uint8Array {
	return concat([tag(field, 0), varint(value)]);
}

export function fieldBytes(field: number, value: Uint8Array): Uint8Array {
	return concat([tag(field, 2), varint(value.length), value]);
}

export function fieldString(field: number, value: string): Uint8Array {
	return fieldBytes(field, new TextEncoder().encode(value));
}

// Protobuf "delimited" framing (gogo protoio): uvarint length prefix + message.
export function delimited(message: Uint8Array): Uint8Array {
	return concat([varint(message.length), message]);
}

export interface ProtoField {
	field: number;
	wire: number;
	value: bigint;
	bytes: Uint8Array;
}

export function readFields(buf: Uint8Array): ProtoField[] {
	const fields: ProtoField[] = [];
	let pos = 0;
	while (pos < buf.length) {
		const [key, keyLen] = readVarint(buf, pos);
		pos += keyLen;
		const field = Number(key >> 3n);
		const wire = Number(key & 7n);

		if (wire === 0) {
			const [value, len] = readVarint(buf, pos);
			pos += len;
			fields.push({ field, wire, value, bytes: new Uint8Array(0) });
		} else if (wire === 2) {
			const [len, lenLen] = readVarint(buf, pos);
			pos += lenLen;
			const bytes = buf.subarray(pos, pos + Number(len));
			pos += Number(len);
			fields.push({ field, wire, value: 0n, bytes });
		} else if (wire === 1) {
			pos += 8;
		} else if (wire === 5) {
			pos += 4;
		} else {
			throw new Error(`protobuf: unsupported wire type ${wire}`);
		}
	}
	return fields;
}

export function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
	let result = 0n;
	let shift = 0n;
	let consumed = 0;
	while (pos + consumed < buf.length) {
		const byte = buf[pos + consumed];
		consumed++;
		result |= BigInt(byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) return [result, consumed];
		shift += 7n;
		if (consumed > 10) break;
	}
	throw new Error('protobuf: truncated varint');
}

export function firstBytes(fields: ProtoField[], field: number): Uint8Array | undefined {
	for (const f of fields) if (f.field === field && f.wire === 2) return f.bytes;
	return undefined;
}

export function firstVarint(fields: ProtoField[], field: number): bigint | undefined {
	for (const f of fields) if (f.field === field && f.wire === 0) return f.value;
	return undefined;
}

export function allBytes(fields: ProtoField[], field: number): Uint8Array[] {
	return fields.filter((f) => f.field === field && f.wire === 2).map((f) => f.bytes);
}
