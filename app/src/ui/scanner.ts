/**
 * A camera read for one QR code. The camera is asked for once the scan
 * starts and answers in its own time: a scan stopped before then, by the
 * person or by the screen going away, stops the stream the moment it
 * arrives rather than leave it running behind a closed sheet.
 */
export interface Scan {
  stop(): void;
}

export interface Detector<V> {
  detect(source: V): Promise<{ rawValue: string }[]>;
}

export interface VideoSource {
  srcObject: MediaProvider | null;
  play(): Promise<void>;
}

export interface ScanOptions<V extends VideoSource> {
  openCamera(): Promise<MediaStream>;
  video: V;
  detector: Detector<V>;
  /** what a code read says; true when it was the one looked for, which ends the scan */
  onCode(rawValue: string): boolean;
  /** the camera could not be opened, or the video would not play */
  onFailure(): void;
  intervalMs?: number;
}

export function startScan<V extends VideoSource>({ openCamera, video, detector, onCode, onFailure, intervalMs = 300 }: ScanOptions<V>): Scan {
  let stopped = false;
  let stream: MediaStream | null = null;
  let next: ReturnType<typeof setTimeout> | undefined;

  function stop() {
    stopped = true;
    clearTimeout(next);
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
  }

  const look = async () => {
    if (stopped) return;
    try {
      for (const { rawValue } of await detector.detect(video)) {
        if (onCode(rawValue)) {
          stop();
          return;
        }
      }
    } catch {
      // not a code, or not one that reads: keep looking
    }
    if (!stopped) next = setTimeout(look, intervalMs);
  };

  void (async () => {
    let opened: MediaStream;
    try {
      opened = await openCamera();
    } catch {
      if (!stopped) onFailure();
      return;
    }
    if (stopped) {
      for (const track of opened.getTracks()) track.stop();
      return;
    }
    stream = opened;
    try {
      video.srcObject = stream;
      await video.play();
    } catch {
      stop();
      onFailure();
      return;
    }
    if (!stopped) next = setTimeout(look, intervalMs);
  })();

  return { stop };
}
