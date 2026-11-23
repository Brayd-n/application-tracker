import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { safeFilename, sanitize, sniff } from '../server/uploads.ts';

const jpegWithExif = () =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'secret', Artist: 'me' } })
    .toBuffer();

test('type comes from the content, not the name', async () => {
  assert.equal(sniff(await jpegWithExif()), 'image/jpeg');
  assert.equal(sniff(Buffer.from('%PDF-1.7\n...')), 'application/pdf');
  assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(sniff(Buffer.from('<html><script>alert(1)</script>')), null);
});

test('EXIF metadata is removed from images', async () => {
  const input = await jpegWithExif();
  assert.ok((await sharp(input).metadata()).exif, 'test image should start with EXIF');
  const { data, mime } = await sanitize(input);
  assert.equal(mime, 'image/jpeg');
  assert.equal((await sharp(data).metadata()).exif, undefined);
});

test('files that are not allowed types are rejected', async () => {
  await assert.rejects(sanitize(Buffer.from('MZ\x90\x00 executable')), /Only PNG/);
  await assert.rejects(sanitize(Buffer.from('GIF89a')), /Only PNG/);
});

test('a file with an image header but broken data is rejected', async () => {
  await assert.rejects(sanitize(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02])), /couldn't be read/);
});

test('files over 10 MB are rejected', async () => {
  await assert.rejects(sanitize(Buffer.alloc(10 * 1024 * 1024 + 1)), /10 MB/);
});

test('filenames are made safe', () => {
  assert.ok(!/^\.|\//.test(safeFilename('../../etc/passwd')));
  assert.ok(!safeFilename('a"b\r\n.png').match(/["\r\n]/));
  assert.equal(safeFilename(''), 'file');
});
