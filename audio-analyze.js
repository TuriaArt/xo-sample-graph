// audio-analyze.js — offline audio analysis in the main process (no native deps)
// Parses RIFF headers of WAV/AIFF files to extract sample rate, channels, bit depth,
// duration and uncompressed file size. For other formats (mp3/flac/ogg) it returns
// only what is known from the filesystem (size, mtime).

const fs = require('fs');

function readWavInfo(fd, fileSize) {
  const header = Buffer.alloc(12);
  if (fs.readSync(fd, header, 0, 12, 0) !== 12) return null;
  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') return null;

  let pos = 12;
  let fmt = null;
  let dataBytes = 0;
  while (pos + 8 <= fileSize) {
    const chunk = Buffer.alloc(8);
    let n;
    try { n = fs.readSync(fd, chunk, 0, 8, pos); } catch { break; }
    if (n !== 8) break;
    const id = chunk.toString('ascii', 0, 4);
    const size = chunk.readUInt32LE(4);
    if (id === 'fmt ') {
      const f = Buffer.alloc(Math.min(size, 40));
      try { fs.readSync(fd, f, 0, f.length, pos + 8); } catch { break; }
      fmt = {
        channels: f.readUInt16LE(2),
        sampleRate: f.readUInt32LE(4),
        bitsPerSample: f.length >= 16 ? f.readUInt16LE(14) : 16,
      };
    } else if (id === 'data') {
      dataBytes = size;
      break; // we have enough
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !fmt.sampleRate) return null;
  if (!dataBytes) dataBytes = Math.max(0, fileSize - (pos + 8));
  const bytesPerFrame = Math.max(1, fmt.channels * Math.ceil(fmt.bitsPerSample / 8));
  const frames = Math.floor(dataBytes / bytesPerFrame);
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    duration: frames / fmt.sampleRate,
  };
}

function readAiffInfo(fd, fileSize) {
  const header = Buffer.alloc(12);
  if (fs.readSync(fd, header, 0, 12, 0) !== 12) return null;
  if (header.toString('ascii', 0, 4) !== 'FORM') return null;
  const formType = header.toString('ascii', 8, 12);
  if (formType !== 'AIFF' && formType !== 'AIFC') return null;

  let pos = 12;
  let comm = null;
  let ssndBytes = 0;
  while (pos + 8 <= fileSize) {
    const chunk = Buffer.alloc(8);
    let n;
    try { n = fs.readSync(fd, chunk, 0, 8, pos); } catch { break; }
    if (n !== 8) break;
    const id = chunk.toString('ascii', 0, 4);
    const size = chunk.readUInt32BE(4);
    if (id === 'COMM') {
      const c = Buffer.alloc(Math.min(size, 26));
      try { fs.readSync(fd, c, 0, c.length, pos + 8); } catch { break; }
      const channels = c.readUInt16BE(0);
      const frames = c.readUInt32BE(2);
      const bits = c.readUInt16BE(6);
      // 80-bit IEEE sample rate (big endian): bytes 8..17
      const sampleRate = readIeeeFloat80(c, 8);
      comm = { channels, frames, bits, sampleRate };
    } else if (id === 'SSND') {
      ssndBytes = size;
    }
    pos += 8 + size + (size % 2);
  }
  if (!comm || !comm.sampleRate) return null;
  return {
    sampleRate: comm.sampleRate,
    channels: comm.channels,
    bitsPerSample: comm.bits,
    duration: comm.frames / comm.sampleRate,
  };
}

function readIeeeFloat80(buf, offset) {
  if (buf.length < offset + 10) return 0;
  const sign = buf[offset] & 0x80 ? -1 : 1;
  const exponent = ((buf[offset] & 0x7f) << 8) | buf[offset + 1];
  let mantissa = 0;
  for (let i = 2; i < 10; i++) mantissa = mantissa * 256 + buf[offset + i];
  if (exponent === 0 && mantissa === 0) return 0;
  const e = exponent - 16383;
  return sign * Math.pow(2, e - 63) * mantissa;
}

// MP3: scan for first frame sync (works for CBR/VBR MPEG audio layer 1-3)
const MP3_RATES = {
  1: [44100, 48000, 32000],   // MPEG1
  2: [22050, 24000, 16000],   // MPEG2
  2.5: [11025, 12000, 8000],  // MPEG2.5
};
const MP3_BITRATES_V1L3 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
const MP3_BITRATES_V2L3 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];

function readMp3Info(fd, fileSize) {
  const buf = Buffer.alloc(Math.min(fileSize, 65536));
  try { fs.readSync(fd, buf, 0, buf.length, 0); } catch { return null; }
  // skip ID3v2
  let start = 0;
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'ID3') {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    start = 10 + size;
  }
  for (let i = start; i < buf.length - 4; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      const versionBits = (buf[i + 1] >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
      const layerBits = (buf[i + 1] >> 1) & 0x03;   // 1 = Layer III
      if (versionBits === 1) continue;
      const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
      if (layerBits !== 1) continue; // only Layer III supported here
      const bitrateIdx = (buf[i + 2] >> 4) & 0x0f;
      const rateIdx = (buf[i + 2] >> 2) & 0x03;
      const padding = (buf[i + 2] >> 1) & 0x01;
      const channelMode = (buf[i + 3] >> 6) & 0x03;
      const sampleRate = MP3_RATES[version] && MP3_RATES[version][rateIdx];
      const bitrates = version === 1 ? MP3_BITRATES_V1L3 : MP3_BITRATES_V2L3;
      const bitrate = bitrates[bitrateIdx];
      if (!sampleRate || !bitrate) continue;
      // estimate duration from audio bytes (file size minus tags)
      const audioBytes = Math.max(0, fileSize - start);
      const durationSec = (audioBytes * 8) / (bitrate * 1000);
      return {
        sampleRate,
        channels: channelMode === 3 ? 1 : 2,
        bitsPerSample: 0,
        duration: durationSec,
        bitrate,
      };
    }
  }
  return null;
}

// FLAC: STREAMMETADATA block with min/max block/sample frames
function readFlacInfo(fd, fileSize) {
  const buf = Buffer.alloc(Math.min(fileSize, 65536));
  try { fs.readSync(fd, buf, 0, buf.length, 0); } catch { return null; }
  if (buf.length < 4 || buf.toString('ascii', 0, 4) !== 'fLaC') return null;
  let pos = 4;
  while (pos + 4 <= buf.length) {
    const last = (buf[pos] & 0x80) !== 0;
    const type = buf[pos] & 0x7f;
    const size = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
    if (type === 0) {
      const b = pos + 4;
      if (b + 18 > buf.length) return null;
      const sampleRate = (buf[b + 10] << 12) | (buf[b + 11] << 4) | (buf[b + 12] >> 4);
      const channels = ((buf[b + 12] >> 1) & 0x07) + 1;
      const bits = (((buf[b + 12] & 0x01) << 4) | (buf[b + 13] >> 4)) + 1;
      const totalSamples = Number(((buf[b + 13] & 0x0f) * 2 ** 32) + (buf[b + 14] << 24 | buf[b + 15] << 16 | buf[b + 16] << 8 | buf[b + 17]));
      return {
        sampleRate: sampleRate || 44100,
        channels,
        bitsPerSample: bits,
        duration: sampleRate && totalSamples ? totalSamples / sampleRate : undefined,
      };
    }
    if (last) break;
    pos += 4 + size;
  }
  return null;
}

function analyzeFile(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { error: 'stat failed' };
  }
  const ext = filePath.toLowerCase().match(/\.(wav|aif|aiff|mp3|flac|ogg)$/);
  const base = { size: stat.size, mtime: stat.mtimeMs };
  if (!ext) return base;
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    let info = null;
    switch (ext[1]) {
      case 'wav': info = readWavInfo(fd, stat.size); break;
      case 'aif':
      case 'aiff': info = readAiffInfo(fd, stat.size); break;
      case 'mp3': info = readMp3Info(fd, stat.size); break;
      case 'flac': info = readFlacInfo(fd, stat.size); break;
      default: info = null;
    }
    if (info) return { ...base, ...info };
  } catch {} finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
  return base;
}

module.exports = { analyzeFile };
