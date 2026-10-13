// Global shortcuts of the desktop app: recording a key combination as an Electron accelerator.

export type HotkeyName = 'overlay' | 'mute' | 'window';
export type Hotkeys = Record<HotkeyName, string>;

const NAMED: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec',
};

/** Electron key name for a physical key (layout-independent: `code`, not `key`). */
function keyName(code: string): string | null {
  let m: RegExpMatchArray | null;
  if ((m = code.match(/^Key([A-Z])$/))) return m[1];
  if ((m = code.match(/^Digit(\d)$/))) return m[1];
  if ((m = code.match(/^Numpad(\d)$/))) return `num${m[1]}`;
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return NAMED[code] ?? null;
}

export type Recorded = { accelerator: string } | { error: string } | null;

/**
 * Turns a key press into an accelerator. null = only a modifier so far (keep listening).
 * A shortcut needs Ctrl, Alt or Win — or an F key — so it never takes plain typing keys from games or chat.
 */
export function acceleratorFromEvent(e: KeyboardEvent): Recorded {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(e.key)) return null;
  const key = keyName(e.code);
  if (!key) return { error: 'Tego klawisza nie można użyć w skrócie' };
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter((m): m is string => !!m);
  const strong = e.ctrlKey || e.altKey || e.metaKey;
  if (!strong && !/^F\d+$/.test(key)) return { error: 'Użyj Ctrl, Alt lub Win z innym klawiszem (albo klawisza F1–F24)' };
  return { accelerator: [...mods, key].join('+') };
}

/** Accelerator as shown to the user: "Ctrl+Shift+O". */
export function formatAccelerator(a: string): string {
  return a
    .split('+')
    .map((part) => {
      if (/^(CommandOrControl|CmdOrCtrl|Control|Ctrl)$/i.test(part)) return 'Ctrl';
      if (/^(Super|Meta|Cmd|Command)$/i.test(part)) return 'Win';
      const num = part.match(/^num(\d)$/i);
      if (num) return `Num ${num[1]}`;
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join('+');
}
