import { Outlet } from 'react-router-dom';

export default function WorkflowLayout() {
  return (
    <div className="h-full overflow-y-auto">
      <Outlet />
    </div>
  );
}
