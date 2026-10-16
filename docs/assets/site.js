/*
 * Плагин docsify для сайта документации МедКарты (GitHub Pages,
 * docs.navimed.tech).
 *
 * Адреса страниц — без «#»: docs.navimed.tech/09-routing-engine (режим
 * history). Сайт должен открываться из корня домена; прямой заход на
 * внутреннюю страницу обслуживает docs/404.html — копия index.html.
 *
 * В Markdown-файлах ссылки относительные — так они работают при просмотре
 * на GitHub. На сайте docsify их нужно перевести:
 *   - ссылки на исходный код вне docs/ (../backend/server.js) → файл на
 *     GitHub в документируемом коммите;
 *   - ссылки на другие страницы документации (../02-architecture.md из
 *     adr/) → путь от корня docs/, который понимает docsify; README.md
 *     раздела → адрес раздела («/», «/adr/»);
 *   - ссылки на не-Markdown файлы внутри docs/ (tools/check-docs.mjs) →
 *     файл на GitHub в ветке main: в режиме history docsify перехватывает
 *     переходы внутри сайта и открыть такой файл сам не может;
 *   - картинки внутри docs/ → путь от корня сайта.
 * Блоки ```mermaid превращаются в диаграммы.
 *
 * Функция rewriteLinks не зависит от браузера — её проверяет
 * docs/tools/check-site.mjs.
 */
(function (root) {
  var REPOSITORY = 'https://github.com/MaksimMerkushev/MedKarta';
  var COMMIT = 'd9c0de6098105622d726be7e67224e962a5dd905';
  // Файлы внутри docs/ (скрипты проверки, настройки сайта) появились после
  // документируемого коммита — ссылки на них ведут в ветку main.
  var DOCS_BRANCH = 'main';

  /** Нормализует путь «a/b/../c» → «a/c»; выход за корень сохраняет «../». */
  function normalize(path) {
    var parts = [];
    path.split('/').forEach(function (part) {
      if (part === '' || part === '.') return;
      if (part === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else parts.push(part);
    });
    return parts.join('/');
  }

  function dirname(file) {
    var index = file.lastIndexOf('/');
    return index === -1 ? '' : file.slice(0, index);
  }

  /**
   * @param {string} target ссылка из Markdown
   * @param {string} file путь текущей страницы от корня docs/ (например, adr/002.md)
   * @returns {string} ссылка для docsify
   */
  function rewriteTarget(target, file) {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return target;
    var hashAt = target.indexOf('#');
    var pathPart = hashAt === -1 ? target : target.slice(0, hashAt);
    var hash = hashAt === -1 ? '' : target.slice(hashAt);
    if (!pathPart) return target;
    var base = dirname(file);
    var resolved = normalize((base ? base + '/' : '') + pathPart);
    if (resolved.indexOf('../') === 0) {
      // Вне docs/: docs лежит в корне репозитория, поэтому «../» ведёт в корень.
      return REPOSITORY + '/blob/' + COMMIT + '/' + resolved.slice(3) + hash;
    }
    if (/(?:^|\/)README\.md$/i.test(resolved)) return '/' + resolved.replace(/README\.md$/i, '') + hash;
    if (/\.md$/i.test(resolved)) return resolved + hash;
    if (/\.(?:png|jpe?g|gif|svg|webp)$/i.test(resolved)) return '/' + resolved;
    return REPOSITORY + '/blob/' + DOCS_BRANCH + '/docs/' + resolved + hash;
  }

  /** Переписывает ссылки вне блоков кода. */
  function rewriteLinks(markdown, file) {
    var fence = null;
    return markdown.split('\n').map(function (line) {
      var opener = line.match(/^\s*(```|~~~)/);
      if (opener) {
        if (!fence) fence = opener[1];
        else if (line.trim().indexOf(fence) === 0) fence = null;
        return line;
      }
      if (fence) return line;
      return line.replace(/(\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g, function (all, open, target, close) {
        return open + rewriteTarget(target, file) + close;
      });
    }).join('\n');
  }

  function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  var api = { rewriteLinks: rewriteLinks, rewriteTarget: rewriteTarget, normalize: normalize, escapeHtml: escapeHtml };
  root.MedkartaDocs = api;

  if (typeof window === 'undefined') return;

  // Старые адреса с «#» (docs.navimed.tech/#/09-routing-engine) — в адрес без «#».
  if (/^#\/./.test(window.location.hash)) {
    window.history.replaceState(null, '', window.location.hash.slice(1));
  }

  window.$docsify = {
    name: 'МедКарта',
    repo: REPOSITORY,
    homepage: 'README.md',
    routerMode: 'history',
    loadSidebar: true,
    alias: { '/.*/_sidebar.md': '/_sidebar.md' },
    subMaxLevel: 2,
    maxLevel: 3,
    auto2top: true,
    search: {
      placeholder: 'Поиск по документации',
      noData: 'Ничего не найдено',
      depth: 3,
    },
    markdown: {
      renderer: {
        code: function (code, lang) {
          if (lang === 'mermaid') return '<div class="mermaid">' + escapeHtml(code) + '</div>';
          return this.origin.code.apply(this, arguments);
        },
      },
    },
    plugins: [
      function (hook, vm) {
        hook.beforeEach(function (markdown) {
          var file = (vm.route && vm.route.file) || 'README.md';
          return rewriteLinks(markdown, file);
        });
        hook.doneEach(function () {
          if (window.mermaid && typeof window.mermaid.run === 'function') {
            window.mermaid.run({ querySelector: '.markdown-section .mermaid' }).catch(function () {
              // Ошибка в одной диаграмме не должна ломать страницу: исходник остаётся виден.
            });
          }
        });
      },
    ],
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
