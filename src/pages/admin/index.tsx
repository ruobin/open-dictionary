import { Routes, Route } from 'react-router-dom'
import RequireAdmin from './RequireAdmin'
import AdminLayout from './AdminLayout'
import Overview from './Overview'
import Providers from './Providers'
import Latency from './Latency'
import Playground from './Playground'
import Entries from './Entries'
import Reports from './Reports'
import Activity from './Activity'
import Audit from './Audit'
import '../../styles/admin.css'

/** Lazy-loaded entry point for the whole /admin/* subtree (see src/App.tsx) —
 *  this module, and admin.css with it, never ships in the main bundle. */
export default function AdminApp() {
  return (
    <RequireAdmin>
      <Routes>
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<Overview />} />
          <Route path="providers" element={<Providers />} />
          <Route path="latency" element={<Latency />} />
          <Route path="playground" element={<Playground />} />
          <Route path="entries" element={<Entries />} />
          <Route path="reports" element={<Reports />} />
          <Route path="activity" element={<Activity />} />
          <Route path="audit" element={<Audit />} />
        </Route>
      </Routes>
    </RequireAdmin>
  )
}
