// Qualification diagnostics must never serialize assertion actual/expected,
// raw child stdout/stderr, ENV or Config bytes. Failures still retain exit status.
export default async function* safeS1BReporter(events) {
  for await (const event of events) {
    const { type, data } = event;
    if (type === 'test:pass' || type === 'test:fail') {
      const duration = Number(data.details?.duration_ms ?? 0);
      yield `${type === 'test:pass' ? '✔' : '✖'} ${
        data.name
      } (${duration}ms)\n`;
      if (type === 'test:fail') {
        const error = data.details?.error;
        const raw = error?.cause?.code ?? error?.code;
        const code =
          typeof raw === 'string' && /^[A-Z][A-Z0-9_]+$/.test(raw)
            ? raw
            : 'TEST_FAILURE';
        yield `  failure_code: ${code}\n`;
        for (const line of String(error?.stack ?? '').split('\n'))
          if (line.trimStart().startsWith('at ')) yield line + '\n';
      }
    } else if (
      type === 'test:diagnostic' &&
      /^(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) [0-9.]+$/.test(
        data.message,
      )
    ) {
      yield 'ℹ ' + data.message + '\n';
    }
  }
}
