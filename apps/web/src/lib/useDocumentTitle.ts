import { useEffect } from 'react';

export const APP_NAME = 'CFB Board';

/** Each page names itself in the tab, so history and tab lists are readable. */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    document.title = title === null ? APP_NAME : `${title} | ${APP_NAME}`;
  }, [title]);
}
