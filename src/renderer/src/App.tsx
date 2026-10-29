import { useState } from 'react'
import { Editor } from './views/Editor'
import { Home } from './views/Home'

/** `notice`: what the editor says once the project is open (a copy just made, docs/design/vertical-video.md §2.3). */
type Route = { view: 'home' } | { view: 'editor'; projectId: string; notice?: string }

export function App(): JSX.Element {
  const [route, setRoute] = useState<Route>({ view: 'home' })
  if (route.view === 'editor') {
    // Keyed by the project: opening a copy, or its original, remounts the editor.
    return (
      <Editor
        key={route.projectId}
        projectId={route.projectId}
        onClose={() => setRoute({ view: 'home' })}
        onOpenProject={(projectId, notice) => setRoute({ view: 'editor', projectId, notice })}
        notice={route.notice}
      />
    )
  }
  return <Home onOpenProject={(projectId) => setRoute({ view: 'editor', projectId })} />
}
