export function LogLine(props: { text: string }) {
  const colorClass = () => {
    const t = props.text;
    // Match bracketed log-level prefixes [ERROR] / [FATAL] (the common
    // pipeline Log event format) OR a bare "FATAL:" / "ERROR:" prefix
    // emitted by the fatal-error handler.  Brackets-only matching prevents
    // miscolouring e.g. "non-fatal" in regular log text.
    if (
      t.includes('[ERROR]') ||
      t.includes('[FATAL]') ||
      /^(?:FATAL|ERROR):/i.test(t)
    )
      return 'text-error';
    if (t.includes('[WARN]')) return 'text-warning';
    if (t.includes('[SUCCESS]')) return 'text-success';
    if (t.includes('[INFO]')) return 'text-info/80';
    return '';
  };

  return (
    <pre class={`whitespace-pre-wrap break-words ${colorClass()}`}>
      <code>{props.text}</code>
    </pre>
  );
}
