import { useEffect, useState } from 'react';

const currentRoute = () => window.location.hash.replace(/^#/, '') || '/';

/** `#/trimble` is the entry point Trimble Connect loads via public/manifest.json. */
export default function App() {
  const [route, setRoute] = useState(currentRoute);

  useEffect(() => {
    const onHashChange = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const inTrimble = route.startsWith('/trimble');

  return (
    <main>
      <h1>TC Codex</h1>
      <p>{inTrimble ? 'Startad från Trimble Connect.' : 'Ny applikation – inget innehåll ännu.'}</p>
    </main>
  );
}
