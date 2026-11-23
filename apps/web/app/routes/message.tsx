import { mailHref } from "@web/app/mail";
import { redirect } from "react-router";
import type { Route } from "./+types/message";

export function loader({ params }: Route.LoaderArgs) {
  return redirect(mailHref({ view: "all" }, params.id));
}
