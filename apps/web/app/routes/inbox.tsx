import { mailHref } from "@web/app/mail";
import { redirect } from "react-router";
import type { Route } from "./+types/inbox";

export function loader({ request }: Route.LoaderArgs) {
  const search = new URL(request.url).searchParams;
  const inbox = search.get("inbox");
  return redirect(
    mailHref({
      view: "all",
      dir: "in",
      ...(inbox === null ? {} : { inbox }),
      q: search.get("q") ?? "",
    }),
  );
}
