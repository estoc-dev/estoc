import { describe, expect, it } from "vitest";

import { startScan, type Detector, type VideoSource } from "../src/ui/scanner.js";

function fakeStream() {
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  return { stream: { getTracks: () => tracks } as unknown as MediaStream, tracks };
}

const stillVideo = (): VideoSource => ({ srcObject: null, play: () => Promise.resolve() });
const seeing = (codes: string[]): Detector<VideoSource> => ({ detect: () => Promise.resolve(codes.map((rawValue) => ({ rawValue }))) });

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a scan", () => {
  it("stops the stream the camera hands over after the scan was stopped", async () => {
    const { stream, tracks } = fakeStream();
    let handOver = (_: MediaStream) => {};
    const scan = startScan({
      openCamera: () => new Promise<MediaStream>((resolve) => (handOver = resolve)),
      video: stillVideo(),
      detector: seeing([]),
      onCode: () => true,
      onFailure: () => {},
    });
    scan.stop();
    handOver(stream);
    await tick();
    expect(tracks[0]!.stopped).toBe(true);
  });

  it("stops the stream when the video will not play, and says so", async () => {
    const { stream, tracks } = fakeStream();
    let failed = false;
    startScan({
      openCamera: () => Promise.resolve(stream),
      video: { srcObject: null, play: () => Promise.reject(new Error("no")) },
      detector: seeing([]),
      onCode: () => true,
      onFailure: () => (failed = true),
    });
    await tick();
    expect(tracks[0]!.stopped).toBe(true);
    expect(failed).toBe(true);
  });

  it("ends on the code it looked for and stops the stream", async () => {
    const { stream, tracks } = fakeStream();
    const read: string[] = [];
    startScan({
      openCamera: () => Promise.resolve(stream),
      video: stillVideo(),
      detector: seeing(["not it", "it"]),
      onCode: (code) => {
        read.push(code);
        return code === "it";
      },
      onFailure: () => {},
      intervalMs: 1,
    });
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(read).toEqual(["not it", "it"]);
    expect(tracks[0]!.stopped).toBe(true);
  });

  it("drops a code read that finishes after the scan was stopped", async () => {
    const { stream, tracks } = fakeStream();
    const read: string[] = [];
    let finish = (_: { rawValue: string }[]) => {};
    const scan = startScan({
      openCamera: () => Promise.resolve(stream),
      video: stillVideo(),
      detector: { detect: () => new Promise((resolve) => (finish = resolve)) },
      onCode: (code) => {
        read.push(code);
        return true;
      },
      onFailure: () => {},
      intervalMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    scan.stop();
    finish([{ rawValue: "late" }]);
    await tick();
    expect(read).toEqual([]);
    expect(tracks[0]!.stopped).toBe(true);
  });

  it("says nothing when the camera refuses after the scan was stopped", async () => {
    let failed = false;
    let refuse = () => {};
    const scan = startScan({
      openCamera: () => new Promise<MediaStream>((_, reject) => (refuse = () => reject(new Error("denied")))),
      video: stillVideo(),
      detector: seeing([]),
      onCode: () => true,
      onFailure: () => (failed = true),
    });
    scan.stop();
    refuse();
    await tick();
    expect(failed).toBe(false);
  });
});
