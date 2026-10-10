"""CSV parsing, header auto-mapping and safe writing (SPEC §8.2, §8.3). Pure functions."""

from __future__ import annotations

from pathlib import Path

import pytest

from raisebook.core.errors import ImportInvalid
from raisebook.services import csv_io
from raisebook.services.exports import ROUND_CSV_COLUMNS

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"
STAGE_NAMES = ["new", "New", "research", "Researching", "meeting", "Meeting", "dd", "Diligence"]


def test_parse_basic_fixture() -> None:
    parsed = csv_io.parse_csv((FIXTURES / "investors_basic.csv").read_text())
    assert parsed.delimiter == ","
    assert parsed.columns[0] == "Full Name"
    assert len(parsed.rows) == 8
    assert parsed.line_numbers[0] == 2
    # Quoted comma stays in one cell.
    assert parsed.rows[0][5] == "$500k-$2M, leads"


def test_bom_semicolon_and_crlf() -> None:
    parsed = csv_io.parse_csv((FIXTURES / "investors_semicolon.csv").read_bytes())
    assert parsed.delimiter == ";"
    assert parsed.columns == ["Name", "Firm", "Email", "Tags"]
    assert parsed.rows[0] == [
        "Grace Holloway",
        "Larkspur Hill Capital",
        "grace@example.com",
        "lead|robotics",
    ]


def test_tab_delimiter_quoted_newline_and_blank_lines() -> None:
    text = 'Name\tNotes\n\n"Dana Whitfield"\t"line one\nline two"\n\nMarcus Odell\t\n'
    parsed = csv_io.parse_csv(text)
    assert parsed.delimiter == "\t"
    assert parsed.rows == [["Dana Whitfield", "line one\nline two"], ["Marcus Odell", ""]]
    assert parsed.line_numbers == [4, 6]


def test_short_and_long_rows_are_padded_and_cut() -> None:
    parsed = csv_io.parse_csv("Name,Firm\nDana\nMarcus,Juniper,extra\n")
    assert parsed.rows == [["Dana", ""], ["Marcus", "Juniper"]]


def test_duplicate_and_empty_headers_get_unique_names() -> None:
    parsed = csv_io.parse_csv("Name,Name,,Email\na,b,c,d\n")
    assert parsed.columns == ["Name", "Name (2)", "Column 3", "Email"]


@pytest.mark.parametrize("text", ["", "   \n\n"])
def test_empty_file_is_invalid(text: str) -> None:
    with pytest.raises(ImportInvalid):
        csv_io.parse_csv(text)


def test_row_limit() -> None:
    text = "Name\n" + "\n".join(f"Investor {i}" for i in range(6))
    with pytest.raises(ImportInvalid) as exc:
        csv_io.parse_csv(text, max_rows=5)
    assert exc.value.code == "import_invalid"
    assert exc.value.details == {"limit_rows": 5}


def test_size_limit() -> None:
    with pytest.raises(ImportInvalid):
        csv_io.parse_csv("Name\n" + "x" * (csv_io.MAX_BYTES + 1))


def test_non_utf8_bytes_are_invalid() -> None:
    with pytest.raises(ImportInvalid):
        csv_io.parse_csv("Name\nJos\xe9\n".encode("latin-1"))


def test_auto_map_aliases() -> None:
    cols = [
        "Full Name",
        "Fund",
        "E-mail",
        "LinkedIn Profile",
        "Investor Type",
        "Cheque size",
        "Tags",
        "Industry",
        "Met at",
        "Intro by",
        "Twitter",
        "Pipeline Stage",
        "Priority",
        "Follow-up date",
        "Soft circle",
        "Committed",
        "%",
        "Next step",
        "Owner",
        "Something else",
    ]
    m = csv_io.auto_map(cols)
    assert m == {
        "Full Name": "name",
        "Fund": "firm",
        "E-mail": "email",
        "LinkedIn Profile": "linkedin_url",
        "Investor Type": "type",
        "Cheque size": "check_note",
        "Tags": "tags",
        "Industry": "industries",
        "Met at": "source",
        "Intro by": "warm_intro_by",
        "Twitter": "x_url",
        "Pipeline Stage": "stage",
        "Priority": "fit",
        "Follow-up date": "follow_up_on",
        "Soft circle": "amount_soft",
        "Committed": "amount_committed",
        "%": "probability",
        "Next step": "next_step",
        "Owner": "owner_email",
        "Something else": None,
    }


def test_first_last_name_and_first_column_wins() -> None:
    m = csv_io.auto_map(["First name", "Last name", "Company", "Organization"])
    assert m == {
        "First name": "first_name",
        "Last name": "last_name",
        "Company": "firm",
        "Organization": None,
    }


def test_bare_stage_column_is_pipeline_stage_only_when_values_are_stages() -> None:
    rows = [["Meeting"], ["Diligence"], ["new"]]
    assert csv_io.auto_map(["Stage"], rows, stage_names=STAGE_NAMES) == {"Stage": "stage"}
    rows = [["Seed"], ["Series A"], ["Pre-seed"]]
    assert csv_io.auto_map(["Stage"], rows, stage_names=STAGE_NAMES) == {"Stage": "stage_focus"}
    assert csv_io.auto_map(["Stage"], [["Meeting"]]) == {"Stage": "stage_focus"}


def test_export_header_maps_to_canonical_fields() -> None:
    m = csv_io.auto_map(
        list(ROUND_CSV_COLUMNS), [["x"] * len(ROUND_CSV_COLUMNS)], stage_names=["x"]
    )
    assert m["linkedin_url"] == "linkedin_url"
    assert m["follow_up_on"] == "follow_up_on"
    assert m["stage"] == "stage"
    assert m["fit"] == "fit"
    assert m["priority"] is None  # fit already took that field
    assert m["investor_id"] is None and m["stage_label"] is None
    assert m["owner_email"] == "owner_email"


def test_validate_mapping() -> None:
    cols = ["A", "B", "C"]
    assert csv_io.validate_mapping(cols, {"A": "name", "B": None}) == {
        "A": "name",
        "B": None,
        "C": None,
    }
    with pytest.raises(ImportInvalid):
        csv_io.validate_mapping(cols, {"Z": "name"})
    with pytest.raises(ImportInvalid):
        csv_io.validate_mapping(cols, {"A": "favorite_color"})
    with pytest.raises(ImportInvalid):
        csv_io.validate_mapping(cols, {"A": "name", "B": "name"})


@pytest.mark.parametrize(
    ("raw", "fit"),
    [("5", 5), ("0", 0), ("hot", 5), ("Warm", 4), ("maybe", 3), ("low", 1), ("4/5", 4), ("", None)],
)
def test_parse_fit(raw: str, fit: int | None) -> None:
    assert csv_io.parse_fit(raw) == fit


@pytest.mark.parametrize("raw", ["6", "-1", "great"])
def test_parse_fit_invalid(raw: str) -> None:
    with pytest.raises(ValueError):
        csv_io.parse_fit(raw)


@pytest.mark.parametrize(("raw", "p"), [("40", 40), ("40%", 40), ("0.4", 40), ("", None)])
def test_parse_probability(raw: str, p: int | None) -> None:
    assert csv_io.parse_probability(raw) == p


@pytest.mark.parametrize("raw", ["101", "lots"])
def test_parse_probability_invalid(raw: str) -> None:
    with pytest.raises(ValueError):
        csv_io.parse_probability(raw)


def test_currency_symbol() -> None:
    assert csv_io.currency_symbol_of("€500k") == "EUR"
    assert csv_io.currency_symbol_of("$250k") == "USD"
    assert csv_io.currency_symbol_of("250000") is None


@pytest.mark.parametrize("cell", ["=1+1", "+44 20", "-5", "@SUM(A1)", "\tx", "\rx"])
def test_formula_guard_round_trips(cell: str) -> None:
    guarded = csv_io.guard_cell(cell)
    assert guarded == "'" + cell
    assert csv_io.unguard_cell(guarded) == cell


def test_guard_leaves_normal_cells_and_unguard_keeps_plain_apostrophes() -> None:
    assert csv_io.guard_cell("Dana") == "Dana"
    assert csv_io.unguard_cell("'tis the season") == "'tis the season"


def test_write_csv_joins_lists_and_guards() -> None:
    text = csv_io.write_csv(["name", "tags", "n", "none"], [["=cmd()", ["a", "b"], 3, None]])
    assert text == "name,tags,n,none\r\n'=cmd(),a; b,3,\r\n"
    back = csv_io.parse_csv(text)
    assert back.rows == [["'=cmd()", "a; b", "3", ""]]
