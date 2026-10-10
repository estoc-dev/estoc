/**
 * A camera and a QR reader for a browser that has neither: each track
 * handed out is written down with whether it was stopped, and the reader
 * sees whatever codes the test holds up. Imported ahead of the app's
 * modules, which ask once, on loading, whether codes can be read here.
 */
export const camera = { tracks: [] as { stopped: boolean }[], codes: [] as string[] };

const shown = new WeakMap<HTMLMediaElement, MediaProvider | null>();

Object.defineProperty(navigator, "mediaDevices", {
  configurable: true,
  value: {
    getUserMedia: async () => {
      const track = { stopped: false, stop: () => (track.stopped = true) };
      camera.tracks.push(track);
      return { getTracks: () => [track] } as unknown as MediaStream;
    },
  },
});
Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
  configurable: true,
  get(this: HTMLMediaElement) {
    return shown.get(this) ?? null;
  },
  set(this: HTMLMediaElement, stream: MediaProvider | null) {
    shown.set(this, stream);
  },
});
HTMLMediaElement.prototype.play = async () => undefined;
Object.assign(globalThis, {
  BarcodeDetector: class {
    async detect(): Promise<{ rawValue: string }[]> {
      return camera.codes.map((rawValue) => ({ rawValue }));
    }
  },
});
