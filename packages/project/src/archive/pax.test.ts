import { describe, expect, it } from "vitest";

import { ArchiveRejectedError } from "./errors.js";
import { scanArchive } from "./scanner.js";
import { buildTar } from "./test-fixtures.js";

function withFirstTarTypeflag(archive: Buffer, typeflag: "x" | "g"): Buffer {
  const bytes = Buffer.from(archive);
  bytes.write(typeflag, 156, 1, "ascii");

  // Recalculate the first header checksum after changing the typeflag.
  bytes.write("        ", 148, 8, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i += 1) {
    sum += bytes[i] as number;
  }
  const checksum = sum.toString(8).padStart(6, "0");
  bytes.write(checksum, 148, 6, "ascii");
  bytes.writeUInt8(0, 154);
  bytes.writeUInt8(0x20, 155);
  return bytes;
}

function expectUnsupportedPax(archive: Buffer): void {
  let caught: unknown;
  try {
    scanArchive({ bytes: archive, format: "tar" });
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(ArchiveRejectedError);
  expect((caught as ArchiveRejectedError).code).toBe("unsupported_format");
}

describe("M-014 tar PAX ambiguity hardening", () => {
  it("rejects a per-file PAX header before a safe-looking following member", () => {
    const archive = buildTar([
      { path: "PaxHeader", content: "27 path=../../escape.txt\n" },
      { path: "safe.txt", content: "safe" },
    ]);

    expectUnsupportedPax(withFirstTarTypeflag(archive, "x"));
  });

  it("rejects a global PAX header", () => {
    const archive = buildTar([
      { path: "GlobalPaxHeader", content: "27 path=../../escape.txt\n" },
      { path: "safe.txt", content: "safe" },
    ]);

    expectUnsupportedPax(withFirstTarTypeflag(archive, "g"));
  });
});
