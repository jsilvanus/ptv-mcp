/**
 * The server injects the public installation path into the document's <base>
 * element. The same built image therefore works at / or under DOMAIN_PATH.
 */
function basePath(): string {
  const href = document.querySelector('base[data-app-base]')?.getAttribute('href') ?? '/';
  const pathname = new URL(href, window.location.origin).pathname;
  return pathname.endsWith('/') ? pathname : `${pathname}/`;
}

/** Build an application-local URL that respects the runtime deployment prefix. */
export function appPath(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  const relativePath = path.startsWith('/') ? path.slice(1) : path;
  return `${basePath()}${relativePath}`;
}

/** React Router expects a basename without a trailing slash (except for root). */
export function routerBasename(): string {
  const path = basePath();
  return path === '/' ? '/' : path.slice(0, -1);
}
