/** Release metadata is injected from package.json by Vite. */
export function VersionBadge() {
  return (
    <span className="release-badge" aria-label={`MADchatter version ${__APP_VERSION__}`} title={`MADchatter v${__APP_VERSION__}`}>
      v{__APP_VERSION__}
    </span>
  );
}
