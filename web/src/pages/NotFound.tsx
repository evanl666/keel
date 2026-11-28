import { Link } from "react-router";
import { buttonClass, EmptyState, PageHeader } from "../components/ui";

export function NotFound() {
  return (
    <>
      <PageHeader title="Not found" />
      <EmptyState
        title="This page isn't here"
        line="The link may be old, or the item was removed."
        action={
          <Link to="/" className={buttonClass("primary")}>
            Back to overview
          </Link>
        }
      />
    </>
  );
}
