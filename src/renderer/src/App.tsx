import { useEffect, useState } from 'react'
import { Editor } from './views/Editor'
import { Home } from './views/Home'
import { reopenAfterRelaunch } from './i18n/boot'
import { ReviewOverlay } from './i18n/reviewOverlay'

/** `notice`: what the editor says once the project is open (a copy just made, docs/design/vertical-video.md §2.3). */
type Route = { view: 'home' } | { view: 'editor'; projectId: string; notice?: string }

export function App(): JSX.Element {
  const [route, setRoute] = useState<Route>({ view: 'home' })
  // After a restart to change the language, the project that was open opens again (output-and-languages §9.4).
  useEffect(() => reopenAfterRelaunch((projectId) => setRoute({ view: 'editor', projectId })), [])
  if (route.view === 'editor') {
    // Keyed by the project: opening a copy, or its original, remounts the editor.
    return (
      <>
        <Editor
          key={route.projectId}
          projectId={route.projectId}
          onClose={() => setRoute({ view: 'home' })}
          onOpenProject={(projectId, notice) => setRoute({ view: 'editor', projectId, notice })}
          notice={route.notice}
        />
        <ReviewOverlay />
      </>
    )
  }
  return (
    <>
      <Home onOpenProject={(projectId) => setRoute({ view: 'editor', projectId })} />
      <ReviewOverlay />
    </>
  )
}
