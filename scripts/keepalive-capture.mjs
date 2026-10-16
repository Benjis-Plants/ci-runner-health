// Reports a keep-alive workflow failure to Sentry with route "keepalive". Never throws.
import { captureError } from './report.mjs';

await captureError(new Error('ci-runner-health keepalive failed'), { route: 'keepalive' });
