/**
 * GET /api/properties/:id/reservations — reservations in a date range.
 * Member (owner or assigned dispatcher): guest names are operational data
 * both roles need. Supports ?from=YYYY-MM-DD&to=YYYY-MM-DD.
 */
import { and, eq, gte, lte } from "drizzle-orm";
import { apiErrorResponse, assertDate } from "@/lib/api";
import { requireSession } from "@/lib/auth-helpers";
import { getDbApp, withUser } from "@/lib/db";
import { reservations } from "@/lib/schema";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireSession();
    const { id } = await params;
    const url = new URL(req.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (from) assertDate(from, "from");
    if (to) assertDate(to, "to");

    const rows = await withUser(getDbApp(), session.appUserId, (tx) => {
      const conds = [eq(reservations.propertyId, id)];
      if (from) conds.push(gte(reservations.checkIn, from));
      if (to) conds.push(lte(reservations.checkOut, to));
      return tx
        .select({
          id: reservations.id,
          uid: reservations.uid,
          guest_name: reservations.guestName,
          check_in: reservations.checkIn,
          check_out: reservations.checkOut,
        })
        .from(reservations)
        .where(and(...conds))
        .orderBy(reservations.checkIn)
        .limit(500);
    });
    return Response.json(rows);
  } catch (e) {
    return apiErrorResponse(e);
  }
}
