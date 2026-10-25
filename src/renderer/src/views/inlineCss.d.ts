// A stylesheet Vite hands over as text (`import css from './file.css?inline'`), for documents the
// app fills itself (the camera bubble's window).
declare module '*.css?inline' {
  const css: string
  export default css
}
