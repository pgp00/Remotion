import {Config} from "@remotion/cli/config";

import {forceMonoAac} from "../../scripts/lib/render-qc.mjs";

Config.overrideFfmpegCommand(forceMonoAac);
