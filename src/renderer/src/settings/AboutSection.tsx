import { useEffect, useRef, useState } from 'react'
import type { AppInfo } from '../../../shared/api/brand'
import { APP_NAME, COMPANY_NAME, COMPANY_URL, COMPANY_URL_LABEL, COPYRIGHT } from '../../../shared/brand'
import { BrandLogo } from '../components/BrandLogo'
import './about.css'

/**
 * About Flown: logo, version, who makes it and a link to their website. The link goes through
 * the main process (window.api.openCompanyWebsite), which opens that one address in the browser;
 * the app's windows themselves never navigate. `reveal` scrolls it into view (Settings opened
 * from "About Flown").
 */
export function AboutSection({ reveal = false }: { reveal?: boolean }): JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    window.api.getAppInfo().then(setInfo, () => setInfo(null))
  }, [])
  useEffect(() => {
    if (reveal) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [reveal])

  return (
    <section className="settings-section about-section" aria-labelledby="settings-about-title" ref={ref}>
      <h3 id="settings-about-title">About</h3>
      <div className="about-card">
        <BrandLogo size={48} wordmark={false} />
        <div className="about-text">
          <p className="about-name">
            {info?.name ?? APP_NAME}
            {info && <span className="about-version">Version {info.version}</span>}
          </p>
          <p>
            Built by {COMPANY_NAME} ·{' '}
            <a
              className="link"
              href={COMPANY_URL}
              onClick={(e) => {
                e.preventDefault()
                void window.api.openCompanyWebsite().catch(() => undefined)
              }}
            >
              {COMPANY_URL_LABEL}
            </a>
          </p>
          <p className="about-legal">{COPYRIGHT}</p>
        </div>
      </div>
    </section>
  )
}
