import { useState } from 'react'
import { Editor } from './views/Editor'
import { Home } from './views/Home'

type Route = { view: 'home' } | { view: 'editor'; projectId: string }

export function App(): JSX.Element {
  const [route, setRoute] = useState<Route>({ view: 'home' })
  if (route.view === 'editor') {
    return <Editor key={route.projectId} projectId={route.projectId} onClose={() => setRoute({ view: 'home' })} />
  }
  return <Home onOpenProject={(projectId) => setRoute({ view: 'editor', projectId })} />
}
