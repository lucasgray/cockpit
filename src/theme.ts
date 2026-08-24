import { monaco } from './monaco-env';

export function registerCockpitTheme() {
  monaco.editor.defineTheme('cockpit-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'c5cad6' },
      { token: 'comment', foreground: '5b6273', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c58fe0', fontStyle: 'italic' },
      { token: 'number', foreground: '9aa4ef' },
      { token: 'string', foreground: '9cc77e' },
      { token: 'string.escape', foreground: '9cc77e' },
      { token: 'type.identifier', foreground: 'e0a56a', fontStyle: 'italic' },
      { token: 'identifier', foreground: 'c5cad6' },
      { token: 'delimiter', foreground: '8b91a1' },
      { token: 'delimiter.bracket', foreground: '8b91a1' },
      { token: 'delimiter.parenthesis', foreground: '8b91a1' },
    ],
    colors: {
      'editor.background': '#181b23',
      'editor.foreground': '#c5cad6',
      'editorLineNumber.foreground': '#454b5c',
      'editorLineNumber.activeForeground': '#c58fe0',
      'editor.selectionBackground': '#2a2f42',
      'editor.lineHighlightBackground': '#1e222c',
      'editorGutter.background': '#181b23',
      'editorWidget.background': '#1b1e27',
      'diffEditor.insertedTextBackground': '#3a6a4a44',
      'diffEditor.removedTextBackground': '#7a3a4a44',
      'diffEditor.insertedLineBackground': '#284a3522',
      'diffEditor.removedLineBackground': '#4a283522',
      'scrollbarSlider.background': '#333849aa',
      'scrollbarSlider.hoverBackground': '#3f4557cc',
      'editorOverviewRuler.border': '#00000000',
    },
  });
}
