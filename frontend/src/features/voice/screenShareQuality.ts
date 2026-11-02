export function screenShareProfile(resolution: number, frameRate: number) {
  const height = Number(resolution) === 720 ? 720 : 1080;
  const fps = Number(frameRate) >= 60 ? 60 : 30;
  return {
    width: height === 720 ? 1280 : 1920,
    height,
    fps,
    // Per-peer ceilings; WebRTC still adapts to available bandwidth and CPU.
    maxBitrate: height === 720 ? (fps === 60 ? 5_000_000 : 3_000_000) : (fps === 60 ? 10_000_000 : 6_000_000),
    contentHint: fps === 60 ? 'motion' : 'detail',
    degradationPreference: fps === 60 ? 'balanced' as const : 'maintain-resolution' as const,
  };
}

export type ScreenShareProfile = ReturnType<typeof screenShareProfile>;

export function screenShareConstraints(profile: ScreenShareProfile): MediaTrackConstraints {
  return {
    width: { ideal: profile.width, max: profile.width },
    height: { ideal: profile.height, max: profile.height },
    frameRate: { ideal: profile.fps, max: profile.fps },
  };
}

export function screenCaptureLabel(track: MediaStreamTrack, profile: ScreenShareProfile) {
  const { width, height, frameRate } = track.getSettings();
  const resolution = width && height ? `${width}×${height}` : `Up to ${profile.height}p`;
  return `${resolution} · ${frameRate ? Math.round(frameRate) : profile.fps} FPS`;
}
