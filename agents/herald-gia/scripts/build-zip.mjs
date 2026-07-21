// Builds dist/function.zip for the herald-gia Lambda (SPEC-B section 3 zip path:
// runtime nodejs20.x, handler src/index.handler). Gia has ZERO runtime npm deps
// (@aws-sdk clients ship in the Lambda runtime), so the zip is just package.json
// + src/ (including caps.json). The zip writer is hand-rolled on node:zlib so the
// build needs no devDependencies either (identical to herald-linkedin's builder).
import { deflateRawSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function collect(dir, prefix, out) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) collect(p, `${prefix}${name}/`, out);
    else out.push({ name: `${prefix}${name}`, data: readFileSync(p) });
  }
  return out;
}

const files = [
  { name: 'package.json', data: readFileSync(join(root, 'package.json')) },
  ...collect(join(root, 'src'), 'src/', []),
];

const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
// Fixed DOS date/time (2026-07-21 00:00) - deterministic builds.
const DOS_TIME = u16(0);
const DOS_DATE = u16(((2026 - 1980) << 9) | (7 << 5) | 21);

const locals = []; const centrals = [];
let offset = 0;
for (const f of files) {
  const nameBuf = Buffer.from(f.name, 'utf8');
  const crc = crc32(f.data);
  const comp = deflateRawSync(f.data, { level: 9 });
  const local = Buffer.concat([
    u32(0x04034b50), u16(20), u16(0), u16(8), DOS_TIME, DOS_DATE,
    u32(crc), u32(comp.length), u32(f.data.length),
    u16(nameBuf.length), u16(0), nameBuf, comp,
  ]);
  const central = Buffer.concat([
    u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), DOS_TIME, DOS_DATE,
    u32(crc), u32(comp.length), u32(f.data.length),
    u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf,
  ]);
  locals.push(local);
  centrals.push(central);
  offset += local.length;
}
const centralStart = offset;
const centralBuf = Buffer.concat(centrals);
const eocd = Buffer.concat([
  u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
  u32(centralBuf.length), u32(centralStart), u16(0),
]);
const zip = Buffer.concat([...locals, centralBuf, eocd]);

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'function.zip'), zip);
console.log(`dist/function.zip: ${zip.length} bytes, ${files.length} files`);
for (const f of files) console.log(`  ${f.name}`);
