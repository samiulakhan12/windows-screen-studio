import { DiagnosticsSection } from './DiagnosticsSection'
import { StorageSection } from './StorageSection'
import './health.css'

/** Settings › Storage (F-26) and Diagnostics (X-03), docs/design/hands-off.md. */
export function HealthSections(): JSX.Element {
  return (
    <>
      <StorageSection />
      <DiagnosticsSection />
    </>
  )
}
