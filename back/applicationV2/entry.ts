import { V2Application, V2ApplicationOptions } from './application';
/** Shared application lifetime used by the real CLI and independent-process qualification. */
export async function runV2Application(
  options: V2ApplicationOptions,
  stop: Promise<void>,
  ready: (app: V2Application) => void = () => undefined,
) {
  let stopping = false;
  void stop.then(() => {
    stopping = true;
  });
  while (!stopping) {
    const app = await V2Application.launch(options);
    options = { ...options, initialize: false };
    try {
      ready(app);
      await Promise.race([stop, app.restartRequested]);
    } finally {
      await app.close();
    }
  }
}
