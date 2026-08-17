import assert from "node:assert/strict";
import test from "node:test";
import {mediaTrimFrames} from "../../packages/remotion-video/src/media-trim.ts";

test("media trim uses the source end as an absolute frame", () => {
  assert.deepEqual(mediaTrimFrames({sourceInSeconds: 49, sourceOutSeconds: 52.5, fps: 30}), {
    trimBefore: 1470,
    trimAfter: 1575,
  });
});
