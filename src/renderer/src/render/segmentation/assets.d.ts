// Files Vite copies into the build and hands over as a URL (`import url from './file?url'`).
declare module '*?url' {
  const url: string
  export default url
}
