/** Collect profile load warnings for /agents instead of console.warn. */

export type ProfileDiagnosticCollector = (message: string) => void;

export function createProfileDiagnosticBuffer(): {
  push: ProfileDiagnosticCollector;
  list: () => readonly string[];
  clear: () => void;
} {
  const messages: string[] = [];
  return {
    push: (message) => messages.push(message),
    list: () => messages,
    clear: () => {
      messages.length = 0;
    },
  };
}
