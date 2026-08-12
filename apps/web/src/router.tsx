import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import App from './App'
import { ResultWorkspace } from './jobs/ResultWorkspace'

const FullPreviewConsole = lazy(() => import(
  './fullPreview/FullPreviewConsole'
).then((module) => ({ default: module.FullPreviewConsole })))
const FullPreviewWorkspace = lazy(() => import(
  './fullPreview/FullPreviewWorkspace'
).then((module) => ({ default: module.FullPreviewWorkspace })))

function SimulationRoute() {
  const { jobId } = useParams()
  const navigate = useNavigate()
  if (!jobId) return <Navigate to="/workbench/local" replace />
  return (
    <ResultWorkspace
      jobId={jobId}
      onClose={() => navigate('/workbench/local')}
    />
  )
}

function FullPreviewRoute() {
  const { previewId } = useParams()
  const navigate = useNavigate()
  if (!previewId) return <Navigate to="/workbench/regional-preview" replace />
  return (
    <FullPreviewWorkspace
      previewId={previewId}
      onClose={() => navigate('/workbench/regional-preview')}
    />
  )
}

export function AppRouter() {
  return (
    <Suspense fallback={<div className="regional-loading"><i /><span>载入工作台…</span></div>}>
      <Routes>
        <Route path="/" element={<Navigate to="/workbench/local" replace />} />
        <Route path="/workbench/local" element={<App />} />
        <Route path="/workbench/regional-preview" element={<FullPreviewConsole />} />
        <Route path="/simulations/:jobId" element={<SimulationRoute />} />
        <Route path="/previews/:previewId" element={<FullPreviewRoute />} />
        <Route path="*" element={<Navigate to="/workbench/local" replace />} />
      </Routes>
    </Suspense>
  )
}
