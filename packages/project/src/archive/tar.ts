/**
 * M-014 minimal, bounded POSIX tar structural reader.
 *
 * Reads uncompressed USTAR/GNU tar. Like the ZIP reader, this exists to
 * inspect and reject, never to extract: no filesystem writes, no execution,
 * and every read bounds-checked against the supplied buffer.
 *
 * tar is the format where dangerous entry *types* are most explicit — symlink
 * (`2`), hardlink (`1`), char device (`3`), block device (`4`), FIFO (`6`) —
 * so the typeflag is parsed and surfaced rather than ignored.
 */

import { ArchiveRejectedError } from "./errors.js";
import type { ArchiveScanLimits } from "./limits.js";

const BLOCK_SIZE = 512;

export type TarEntryType =
  | "file"
  | "directory"
  | "symlink"
  | "hardlink"
  | "character_device"
  | "block_device"
  | "fifo"
  | "gnu_long_name"
  | "gnu_long_link"
  | "pax_header"
  | "unknown";

export interface RawTarEntry {
  readonly rawPath: string;
  readonly declaredSize: number;
  readonly entryType: TarEntryType;
  /** Offset of this entry's data payload. */
  readonly dataOffset: number;
}

function typeflagToEntryType(flag: string): TarEntryType {
  switch (flag) {
    case "0":
    case "\0":
    case "7": // contiguous file, treated as a regular file
      return "file";
    case "5":
      return "directory";
    case "1":
      return "hardlink";
    case "2":
      return "symlink";
    case "3":
      return "character_device";
    case "4":
      return "block_device";
    case "6":
      return "fifo";
    case "L":
      return "gnu_long_name";
    case "K":
      return "gnu_long_link";
    case "x":
    case "g":
      return "pax_header";
    default:
      return "unknown";
  }
}

/** Read a NUL/space-terminated field as a string. */
function readString(buffer: Buffer, offset: number, length: number): string {
  const raw = buffer.subarray(offset, offset + length);
  let end = raw.indexOf(0);
  if (end === -1) {
    end = raw.length;
  }
  return raw.subarray(0, end).toString("utf8");
}

/** Read a tar octal numeric field, rejecting malformed values. */
function readOctal(buffer: Buffer, offset: number, length: number): number {
  const text = readString(buffer, offset, length).trim();
  if (text === "") {
    return 0;
  }
  if (!/^[0-7]+$/.test(text)) {
    throw new ArchiveRejectedError(
      "malformed_archive",
      "tar header has a malformed octal numeric field",
    );
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value) || value < 0) {
    throw new ArchiveRejectedError(
      "malformed_archive",
      "tar header has an out-of-range numeric field",
    );
  }
  return value;
}

/** True when a 512-byte block is entirely zero (an end-of-archive marker). */
function isZeroBlock(buffer: Buffer, offset: number): boolean {
  for (let i = offset; i < offset + BLOCK_SIZE; i += 1) {
    if (buffer[i] !== 0) {
      return false;
    }
  }
  return true;
}

/**
 * Verify the tar header checksum. This is the cheapest available proof that a
 * buffer is really a tar header and not attacker-chosen bytes that happen to
 * parse.
 */
function verifyChecksum(buffer: Buffer, offset: number): void {
  const declared = readOctal(buffer, offset + 148, 8);
  let signed = 0;
  let unsigned = 0;
  for (let i = 0; i < BLOCK_SIZE; i += 1) {
    // The checksum field itself is treated as spaces during computation.
    const byte = i >= 148 && i < 156 ? 0x20 : (buffer[offset + i] as number);
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  if (declared !== unsigned && declared !== signed) {
    throw new ArchiveRejectedError(
      "malformed_archive",
      "tar header checksum does not match",
    );
  }
}

/**
 * Read tar entries, enforcing count limits as it goes.
 *
 * GNU long-name (`L`) extensions are honoured so a long path is still
 * subjected to the full path policy rather than being silently truncated to
 * its 100-byte header field. POSIX PAX extended/global headers are rejected
 * until their complete effective-header semantics are implemented: a PAX
 * `path`/`size` override cannot be ignored without creating a scanner/extractor
 * interpretation split over the same accepted archive bytes.
 */
export function readTarEntries(
  buffer: Buffer,
  limits: ArchiveScanLimits,
): RawTarEntry[] {
  if (buffer.length === 0 || buffer.length % BLOCK_SIZE !== 0) {
    throw new ArchiveRejectedError(
      "malformed_archive",
      "tar archive length is not a positive multiple of 512 bytes",
    );
  }

  const entries: RawTarEntry[] = [];
  let offset = 0;
  let pendingLongName: string | undefined;

  while (offset + BLOCK_SIZE <= buffer.length) {
    if (isZeroBlock(buffer, offset)) {
      break; // end-of-archive marker
    }

    verifyChecksum(buffer, offset);

    const magic = readString(buffer, offset + 257, 6);
    if (magic !== "ustar" && magic !== "ustar  " && magic !== "") {
      throw new ArchiveRejectedError(
        "malformed_archive",
        "tar header has an unrecognized magic field",
      );
    }

    const name = readString(buffer, offset, 100);
    const size = readOctal(buffer, offset + 124, 12);
    const typeflag = readString(buffer, offset + 156, 1);
    const prefix = readString(buffer, offset + 345, 155);
    const entryType = typeflagToEntryType(typeflag || "0");

    const dataOffset = offset + BLOCK_SIZE;
    const paddedSize = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    if (dataOffset + paddedSize > buffer.length) {
      throw new ArchiveRejectedError(
        "malformed_archive",
        "tar entry data extends past the end of the archive",
        name,
      );
    }

    if (entryType === "gnu_long_name") {
      if (size > limits.maxPathLength * 4) {
        throw new ArchiveRejectedError(
          "path_too_long",
          "tar GNU long name record is unreasonably large",
        );
      }
      pendingLongName = readString(buffer, dataOffset, size);
      offset = dataOffset + paddedSize;
      continue;
    }

    if (entryType === "pax_header") {
      throw new ArchiveRejectedError(
        "unsupported_format",
        "tar POSIX PAX extended/global headers are not accepted because their effective metadata overrides are not structurally reconciled",
        name,
      );
    }

    if (entryType === "gnu_long_link") {
      // GNU long-link metadata applies only to link targets. Link entries are
      // rejected by the scanner, so this record cannot alter an accepted file.
      offset = dataOffset + paddedSize;
      continue;
    }

    const rawPath =
      pendingLongName ?? (prefix === "" ? name : `${prefix}/${name}`);
    pendingLongName = undefined;

    entries.push({ rawPath, declaredSize: size, entryType, dataOffset });
    if (entries.length > limits.maxEntryCount) {
      throw new ArchiveRejectedError(
        "too_many_entries",
        `tar archive exceeds the entry limit of ${limits.maxEntryCount}`,
      );
    }

    offset = dataOffset + paddedSize;
  }

  if (entries.length === 0) {
    throw new ArchiveRejectedError("malformed_archive", "tar archive contains no entries");
  }

  return entries;
}

/** Read one tar entry's payload bytes. tar is uncompressed, so this is a copy. */
export function readTarEntryContent(buffer: Buffer, entry: RawTarEntry): Buffer {
  return Buffer.from(
    buffer.subarray(entry.dataOffset, entry.dataOffset + entry.declaredSize),
  );
}
