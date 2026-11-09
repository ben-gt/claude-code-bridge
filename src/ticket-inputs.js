import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 15 * 1024 * 1024;

/**
 * Name the stored copy with plain characters only. Screenshot names carry spaces that are not spaces
 * (macOS writes U+202F before "am"), and an agent retyping the path gets it wrong and cannot open the file.
 */
export function storedName(filename) {
  const safe = String(filename).normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^[_.]+/, '').slice(-120);
  return safe || 'attachment';
}

export function validateTicketInput(input) {
  if (input == null) return null;
  if (!/^[A-Z0-9]{8}$/.test(input.ticket_id || '')) throw new Error('Invalid Flux ticket ID');
  if (typeof input.text !== 'string' || input.text.length > 200000) throw new Error('Ticket text is missing or too large');
  if (!Array.isArray(input.attachments) || input.attachments.length > 20) throw new Error('Too many attachments');
  let total = 0;
  const attachments = input.attachments.map((a, index) => {
    if (typeof a.filename !== 'string' || !a.filename || a.filename.length > 255 || /[\\/\x00-\x1f]/.test(a.filename) || a.filename === '.' || a.filename === '..') throw new Error('Unsafe attachment filename');
    if (typeof a.data_base64 !== 'string' || a.data_base64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 || /[^A-Za-z0-9+/=]/.test(a.data_base64)) throw new Error('Invalid attachment data');
    const bytes = Buffer.from(a.data_base64, 'base64');
    if (bytes.toString('base64') !== a.data_base64) throw new Error('Invalid attachment data');
    total += bytes.length;
    if (bytes.length > MAX_ATTACHMENT_BYTES || total > MAX_TOTAL_BYTES) throw new Error('Attachment size limit exceeded');
    return { filename: a.filename, stored_name: `${index + 1}-${storedName(a.filename)}`, bytes, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  return { ticket_id: input.ticket_id, text: input.text, attachments };
}

export function saveTicketInput(jobDir, input) {
  if (!input) return null;
  const dir = path.join(jobDir, 'ticket-input');
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'ticket.txt'), input.text, { mode: 0o600, flag: 'wx' });
  for (const a of input.attachments) fs.writeFileSync(path.join(dir, a.stored_name), a.bytes, { mode: 0o600, flag: 'wx' });
  const manifest = { ticket_id: input.ticket_id, attachments: input.attachments.map(({ bytes, ...a }) => a) };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
  return { directory: dir, ...manifest };
}
