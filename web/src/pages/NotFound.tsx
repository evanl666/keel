import { Link } from "react-router";
import { Button, EmptyState } from "../components/ui";

export function NotFound() {
  return (
    <EmptyState
      icon="🧭"
      title="This page isn't here"
      line="The link may be old, or the item was removed."
      action={
        <Link to="/">
          <Button variant="primary">Back to overview</Button>
        </Link>
      }
    />
  );
}
