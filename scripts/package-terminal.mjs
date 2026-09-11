import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Fixed entries only, deterministic USTAR archive: no shell or external tar required to build.
export function terminalPackage(binary, script, architecture) {
  if (!['amd64', 'arm64'].includes(architecture)) throw new Error('Unsupported architecture');
  const digest = createHash('sha256').update(binary).digest('hex');
  const installer = Buffer.from(script.replaceAll('\r\n','\n').trimEnd().replaceAll('__MACHINE__',architecture==='amd64'?'x86_64':'aarch64')+'\n');
  const installerDigest = createHash('sha256').update(installer).digest('hex');
  const entries = [['allocube-terminal', binary, 0o755], ['install.sh', installer, 0o755], ['SHA256SUMS', Buffer.from(`${digest}  allocube-terminal\n${installerDigest}  install.sh\n`), 0o644]];
  const blocks = [];
  for (const [name, data, mode] of entries) {
    const header = Buffer.alloc(512);
    header.write(`allocube-deploy-linux-${architecture}/${name}`, 0, 100);
    const octal = (value, offset, length) => header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
    octal(mode,100,8); octal(0,108,8); octal(0,116,8); octal(data.length,124,12); octal(0,136,12);
    header.fill(32,148,156); header.write('0',156); header.write('ustar\0',257); header.write('00',263);
    const sum = header.reduce((a,b)=>a+b,0);
    header.write(sum.toString(8).padStart(6,'0')+'\0 ',148,8);
    blocks.push(header, data, Buffer.alloc((512-data.length%512)%512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks),{level:9});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? 'terminal/dist');
  const script = await readFile(new URL('../terminal/deploy/install.sh',import.meta.url),'utf8');
  for (const architecture of ['amd64','arm64']) {
    const binary = await readFile(path.join(root,`allocube-terminal-linux-${architecture}`));
    const artifact = terminalPackage(binary,script,architecture);
    await writeFile(path.join(root,`allocube-deploy-linux-${architecture}.tar.gz`),artifact,{mode:0o644});
    console.log(`${architecture}: ${artifact.length} bytes, SHA256 ${createHash('sha256').update(artifact).digest('hex')}`);
  }
}
