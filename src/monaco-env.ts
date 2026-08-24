import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';

type WorkerCtor = new () => Worker;

const env: { getWorker(workerId: string, label: string): Worker } = {
  getWorker(_workerId, label) {
    const make = (ctor: WorkerCtor) => new ctor();
    switch (label) {
      case 'json':
        return make(jsonWorker);
      case 'css':
      case 'scss':
      case 'less':
        return make(cssWorker);
      case 'html':
      case 'handlebars':
      case 'razor':
        return make(htmlWorker);
      case 'typescript':
      case 'javascript':
        return make(tsWorker);
      default:
        return make(editorWorker);
    }
  },
};

(globalThis as unknown as { MonacoEnvironment: typeof env }).MonacoEnvironment = env;

export { monaco };
