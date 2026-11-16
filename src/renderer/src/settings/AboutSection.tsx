import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppInfo } from '../../../shared/api/brand'
import { APP_NAME, COMPANY_NAME, COMPANY_URL, COMPANY_URL_LABEL, COPYRIGHT } from '../../../shared/brand'
import { BrandLogo } from '../components/BrandLogo'
import { UpdatesBlock } from '../updates/UpdatesBlock'
import { NoticesPanel } from './NoticesPanel'
import './about.css'
import { t, uiLanguage } from '../../../shared/i18n/t'
import { richText } from '../i18n/richText'


/** The company's website as a link that opens in the browser. */
function companyLink(text: ReactNode): JSX.Element {
  return (
    <a
      className="link"
      href={COMPANY_URL}
      onClick={(e) => {
        e.preventDefault()
        void window.api.openCompanyWebsite().catch(() => undefined)
      }}
    >
      {text}
    </a>
  )
}

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
      <h3 id="settings-about-title">{t('settings.about.title')}</h3>
      <div className="about-card">
        <BrandLogo size={48} wordmark={false} />
        <div className="about-text">
          <p className="about-name">
            {info?.name ?? APP_NAME}
            {info && <span className="about-version">{richText('settings.about.version', { version: info.version })}</span>}
          </p>
          <p>
            {uiLanguage() === 'en' ? (
              // English keeps today's text nodes, the words and then the link (merge group, output-and-languages §9.3).
              <>
                {richText('settings.about.builtBy.lead', { company: COMPANY_NAME })}{' '}
                {companyLink(COMPANY_URL_LABEL)}
              </>
            ) : (
              richText('settings.about.builtBy.whole', { company: COMPANY_NAME, site: COMPANY_URL_LABEL }, { link: (chunks) => companyLink(chunks) })
            )}
          </p>
          <p className="about-legal">{COPYRIGHT}</p>
        </div>
      </div>
      <UpdatesBlock />
      <NoticesPanel />
    </section>
  )
}
