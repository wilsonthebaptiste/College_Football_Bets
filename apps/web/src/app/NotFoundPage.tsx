import { Link } from 'react-router';
import { ErrorState } from '../components/States';
import { useDocumentTitle } from '../lib/useDocumentTitle';

export function NotFoundPage() {
  useDocumentTitle('Page not found');
  return (
    <ErrorState
      title="Page not found"
      message="Nothing lives at this address."
      action={
        <Link to="/" className="button">
          See all boards
        </Link>
      }
    />
  );
}
