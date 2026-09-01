import { parseLevel, type LogLevel } from '../../core/logLevels';

// Map a recognised level to its DaisyUI text colour. Unrecognised lines
// (parseLevel returns null) are deliberately styled neutrally — the
// historical behaviour is "<pre> stays default colour" for tag-free
// strings so operator notes don't get mis-coloured as info.
const LEVEL_COLOR: Record<LogLevel, string> = {
  INFO: 'text-info/80',
  WARN: 'text-warning',
  ERROR: 'text-error',
  SUCCESS: 'text-success',
};

export function LogLine(props: { text: string }) {
  const colorClass = (): string => {
    const level = parseLevel(props.text);
    // Early return for unrecognised text: no colour class, matches
    // pre-0.2.4 behaviour.
    if (level === null) return '';
    return LEVEL_COLOR[level];
  };

  return (
    <pre class={`whitespace-pre-wrap break-words ${colorClass()}`}>
      <code>{props.text}</code>
    </pre>
  );
}
