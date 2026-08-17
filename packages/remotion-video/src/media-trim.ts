export const mediaTrimFrames = ({sourceInSeconds, sourceOutSeconds, fps}: {sourceInSeconds: number; sourceOutSeconds: number; fps: number}) => ({
  trimBefore: Math.round(sourceInSeconds * fps),
  trimAfter: Math.round(sourceOutSeconds * fps),
});
