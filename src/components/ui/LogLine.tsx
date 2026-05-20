export function LogLine(props: { text: string }) {
  const colorClass = () => {
    const t = props.text;
    if (t.includes('[ERROR]') || t.includes('FATAL')) return 'text-error';
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
