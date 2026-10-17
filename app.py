
from flask import Flask, render_template, request, jsonify, send_file
from pathlib import Path
import pandas as pd
import sqlite3
import json
import math
from datetime import datetime
from mlxtend.preprocessing import TransactionEncoder
from mlxtend.frequent_patterns import apriori, fpgrowth, association_rules

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 12 * 1024 * 1024

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "market_basket.db"
SAMPLE_PATH = DATA_DIR / "sample_transactions.csv"

DATA_DIR.mkdir(exist_ok=True)


# --------------------------------------------------
# JSON SAFETY FIX
# Convert Infinity, NaN, and non-finite numbers to null.
# This prevents "Unexpected token I, invalid JSON".
# --------------------------------------------------
def clean_json(value):
    if isinstance(value, dict):
        return {
            str(key): clean_json(item)
            for key, item in value.items()
        }

    if isinstance(value, (list, tuple, set, frozenset)):
        return [clean_json(item) for item in value]

    if hasattr(value, "item") and callable(value.item):
        try:
            value = value.item()
        except (ValueError, TypeError):
            pass

    if isinstance(value, float) and not math.isfinite(value):
        return None

    return value


def json_response(data, status=200):
    return app.response_class(
        response=json.dumps(
            clean_json(data),
            allow_nan=False,
            ensure_ascii=False
        ),
        status=status,
        mimetype="application/json"
    )


# --------------------------------------------------
# DATABASE
# --------------------------------------------------
def init_db():
    with sqlite3.connect(DB_PATH) as con:
        con.execute("""
            CREATE TABLE IF NOT EXISTS analyses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                source TEXT NOT NULL,
                algorithm TEXT NOT NULL,
                transaction_count INTEGER NOT NULL,
                product_count INTEGER NOT NULL,
                itemset_count INTEGER NOT NULL,
                rule_count INTEGER NOT NULL,
                min_support REAL NOT NULL,
                min_confidence REAL NOT NULL,
                min_lift REAL NOT NULL
            )
        """)


init_db()


# --------------------------------------------------
# CSV COLUMN DETECTION
# --------------------------------------------------
def find_column(columns, candidates):
    lookup = {
        str(column).strip().lower().replace(" ", "_"): column
        for column in columns
    }

    for candidate in candidates:
        if candidate in lookup:
            return lookup[candidate]

    return None


# --------------------------------------------------
# CONVERT CSV DATA INTO TRANSACTIONS
# Supports:
# 1. transaction_id, product
# 2. Wide CSV: one basket per row
# --------------------------------------------------
def transactions_from_csv(df):
    if df.empty:
        raise ValueError("The CSV file has no data rows.")

    tx_col = find_column(df.columns, [
        "transaction_id",
        "transaction",
        "basket_id",
        "order_id",
        "invoice",
        "invoice_no",
        "receipt_id",
        "purchase_id"
    ])

    product_col = find_column(df.columns, [
        "product",
        "item",
        "item_name",
        "product_name",
        "description",
        "stockcode"
    ])

    if tx_col is not None and product_col is not None:
        work = df[[tx_col, product_col]].dropna().copy()

        work[tx_col] = work[tx_col].astype(str).str.strip()
        work[product_col] = work[product_col].astype(str).str.strip()

        work = work[
            (work[tx_col] != "") &
            (work[product_col] != "") &
            (~work[tx_col].str.lower().isin(["nan", "none"])) &
            (~work[product_col].str.lower().isin(["nan", "none"]))
        ]

        grouped = work.groupby(tx_col)[product_col].apply(
            lambda items: sorted(set(items))
        )

        baskets = [
            items for items in grouped.tolist()
            if items
        ]

    else:
        # Wide format: each row represents one transaction.
        baskets = []

        for _, row in df.iterrows():
            items = []

            for value in row.tolist():
                if pd.notna(value):
                    item = str(value).strip()

                    if item and item.lower() not in {
                        "0", "false", "nan", "none"
                    }:
                        items.append(item)

            if items:
                baskets.append(sorted(set(items)))

    if not baskets:
        raise ValueError(
            "No baskets found. Use columns transaction_id and product "
            "(one product per row), or a wide CSV with product names "
            "across each row."
        )

    return baskets


# --------------------------------------------------
# LOAD SAMPLE DATASET
# --------------------------------------------------
def load_sample():
    if not SAMPLE_PATH.exists():
        raise FileNotFoundError(
            "Sample dataset not found. Please check "
            "data/sample_transactions.csv."
        )

    df = pd.read_csv(SAMPLE_PATH)
    return transactions_from_csv(df)


# --------------------------------------------------
# MARKET BASKET ANALYSIS
# --------------------------------------------------
def analyze_baskets(
    baskets,
    algorithm,
    min_support,
    min_confidence,
    min_lift
):
    # Clean and standardize transaction data.
    baskets = [
        sorted(set(
            str(item).strip()
            for item in basket
            if str(item).strip()
        ))
        for basket in baskets
    ]

    baskets = [basket for basket in baskets if basket]

    if len(baskets) < 2:
        raise ValueError(
            "At least two non-empty transactions are required."
        )

    products = sorted({
        item
        for basket in baskets
        for item in basket
    })

    if len(products) < 2:
        raise ValueError(
            "At least two different products are required."
        )

    # Encode transactions into a Boolean basket matrix.
    encoder = TransactionEncoder()
    encoded = encoder.fit(baskets).transform(baskets)

    basket_df = pd.DataFrame(
        encoded,
        columns=encoder.columns_
    )

    # Run the selected frequent-itemset algorithm.
    if algorithm == "Apriori":
        itemsets = apriori(
            basket_df,
            min_support=min_support,
            use_colnames=True
        )

    elif algorithm == "FP-Growth":
        itemsets = fpgrowth(
            basket_df,
            min_support=min_support,
            use_colnames=True
        )

    else:
        raise ValueError(
            "Algorithm must be Apriori or FP-Growth."
        )

    # Generate association rules.
    if itemsets.empty or not itemsets["itemsets"].map(len).ge(2).any():
        rules = pd.DataFrame()

    else:
        rules = association_rules(
            itemsets,
            metric="confidence",
            min_threshold=min_confidence
        )

        if not rules.empty:
            rules = rules[
                rules["lift"] >= min_lift
            ].copy()

            rules = rules.sort_values(
                ["lift", "confidence", "support"],
                ascending=False
            )

    # Prepare frequent itemsets.
    itemsets = itemsets.copy()

    if not itemsets.empty:
        itemsets["item_labels"] = itemsets["itemsets"].apply(
            lambda items: " + ".join(sorted(items))
        )

        itemsets["length"] = itemsets["itemsets"].apply(len)

        itemsets = itemsets.sort_values(
            ["support", "length"],
            ascending=[False, True]
        )

    def names(value):
        if isinstance(value, (set, frozenset, list, tuple)):
            return sorted(list(value))

        return []

    # Format frequent itemsets for the frontend.
    itemset_records = []

    for _, row in itemsets.head(60).iterrows():
        itemset_records.append({
            "items": names(row["itemsets"]),
            "label": row["item_labels"],
            "support": round(float(row["support"]), 4),
            "count": int(
                round(float(row["support"]) * len(baskets))
            ),
            "length": int(row["length"])
        })

    # Format association rules.
    rule_records = []

    if not rules.empty:
        for _, row in rules.head(100).iterrows():
            conviction = None

            if "conviction" in row.index:
                try:
                    raw_conviction = float(row["conviction"])

                    if math.isfinite(raw_conviction):
                        conviction = round(raw_conviction, 4)

                except (TypeError, ValueError, OverflowError):
                    conviction = None

            rule_records.append({
                "antecedents": names(row["antecedents"]),
                "consequents": names(row["consequents"]),

                "rule": (
                    " + ".join(names(row["antecedents"]))
                    + " → "
                    + " + ".join(names(row["consequents"]))
                ),

                "support": round(float(row["support"]), 4),
                "confidence": round(float(row["confidence"]), 4),
                "lift": round(float(row["lift"]), 4),

                "leverage": (
                    round(float(row["leverage"]), 4)
                    if "leverage" in row.index
                    and math.isfinite(float(row["leverage"]))
                    else 0
                ),

                "conviction": conviction
            })

    # Create practical cross-selling insights.
    insights = []

    for rule in rule_records[:5]:
        antecedent = ", ".join(rule["antecedents"])
        consequent = ", ".join(rule["consequents"])

        confidence_pct = round(
            rule["confidence"] * 100
        )

        lift = rule["lift"]

        if lift > 1.5:
            action = (
                f"Test a bundle or checkout recommendation "
                f"pairing {antecedent} with {consequent}."
            )

        elif lift > 1:
            action = (
                f"Show {consequent} as a related-product suggestion "
                f"when customers buy {antecedent}."
            )

        else:
            action = (
                f"Review whether a low-cost cross-sell test for "
                f"{antecedent} and {consequent} is worthwhile."
            )

        insights.append({
            "title": f"If shoppers buy {antecedent}",

            "description": (
                f"{confidence_pct}% confidence that the basket "
                f"also contains {consequent}; lift is {lift:.2f}."
            ),

            "action": action,
            "lift": lift
        })

    return {
        "transaction_count": len(baskets),
        "product_count": len(products),
        "products": products,
        "itemsets": itemset_records,
        "rules": rule_records,
        "total_frequent_itemsets": int(len(itemsets)),
        "total_rules_after_filters": int(len(rules)),
        "insights": insights,
        "algorithm": algorithm,

        "thresholds": {
            "min_support": min_support,
            "min_confidence": min_confidence,
            "min_lift": min_lift
        }
    }


# --------------------------------------------------
# HOME PAGE
# --------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


# --------------------------------------------------
# SAMPLE DATASET INFORMATION
# --------------------------------------------------
@app.route("/api/sample", methods=["GET"])
def sample_info():
    try:
        baskets = load_sample()

        return json_response({
            "ok": True,
            "transactions": len(baskets),
            "products": len({
                item
                for basket in baskets
                for item in basket
            })
        })

    except Exception as exc:
        return json_response({
            "ok": False,
            "error": str(exc)
        }, 500)


# --------------------------------------------------
# RUN MARKET BASKET ANALYSIS
# --------------------------------------------------
@app.route("/api/analyze", methods=["POST"])
def analyze():
    try:
        algorithm = request.form.get(
            "algorithm", "Apriori"
        ).strip()

        min_support = float(
            request.form.get("min_support", 0.10)
        )

        min_confidence = float(
            request.form.get("min_confidence", 0.30)
        )

        min_lift = float(
            request.form.get("min_lift", 1.0)
        )

        # Validate thresholds.
        if not math.isfinite(min_support) or not (
            0.001 <= min_support <= 1
        ):
            raise ValueError(
                "Minimum support must be between 0.001 and 1."
            )

        if not math.isfinite(min_confidence) or not (
            0 <= min_confidence <= 1
        ):
            raise ValueError(
                "Minimum confidence must be between 0 and 1."
            )

        if not math.isfinite(min_lift) or min_lift < 0:
            raise ValueError(
                "Minimum lift must be a finite number greater than "
                "or equal to zero."
            )

        if algorithm not in {"Apriori", "FP-Growth"}:
            raise ValueError(
                "Choose either Apriori or FP-Growth."
            )

        # Read uploaded CSV or use the built-in sample.
        upload = request.files.get("file")

        if upload and upload.filename:
            if not upload.filename.lower().endswith(".csv"):
                raise ValueError(
                    "Please upload a .csv file."
                )

            df = pd.read_csv(upload)

            baskets = transactions_from_csv(df)
            source = Path(upload.filename).name

        else:
            baskets = load_sample()
            source = "Built-in sample dataset"

        # Execute the analysis.
        result = analyze_baskets(
            baskets,
            algorithm,
            min_support,
            min_confidence,
            min_lift
        )

        result["source"] = source

        # Save analysis history.
        with sqlite3.connect(DB_PATH) as con:
            con.execute("""
                INSERT INTO analyses (
                    created_at,
                    source,
                    algorithm,
                    transaction_count,
                    product_count,
                    itemset_count,
                    rule_count,
                    min_support,
                    min_confidence,
                    min_lift
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                datetime.now().isoformat(timespec="seconds"),
                source,
                algorithm,
                result["transaction_count"],
                result["product_count"],
                result["total_frequent_itemsets"],
                result["total_rules_after_filters"],
                min_support,
                min_confidence,
                min_lift
            ))

        # Return standards-compliant JSON.
        return json_response(result)

    except (
        ValueError,
        pd.errors.ParserError,
        pd.errors.EmptyDataError
    ) as exc:
        return json_response({
            "error": str(exc)
        }, 400)

    except Exception as exc:
        app.logger.exception("Market basket analysis failed")

        return json_response({
            "error": f"Analysis failed: {exc}"
        }, 500)


# --------------------------------------------------
# ANALYSIS HISTORY
# --------------------------------------------------
@app.route("/api/history", methods=["GET"])
def history():
    try:
        with sqlite3.connect(DB_PATH) as con:
            con.row_factory = sqlite3.Row

            rows = con.execute("""
                SELECT
                    created_at,
                    source,
                    algorithm,
                    transaction_count,
                    product_count,
                    itemset_count,
                    rule_count
                FROM analyses
                ORDER BY id DESC
                LIMIT 10
            """).fetchall()

        return json_response([
            dict(row) for row in rows
        ])

    except Exception as exc:
        app.logger.exception("Could not load analysis history")

        return json_response({
            "error": f"Could not load history: {exc}"
        }, 500)


# --------------------------------------------------
# DOWNLOAD SAMPLE CSV
# --------------------------------------------------
@app.route("/api/sample-csv", methods=["GET"])
def sample_csv():
    if not SAMPLE_PATH.exists():
        return json_response({
            "error": "Sample CSV file was not found."
        }, 404)

    return send_file(
        SAMPLE_PATH,
        as_attachment=True,
        download_name="sample_transactions.csv",
        mimetype="text/csv"
    )


# --------------------------------------------------
# START FLASK SERVER
# --------------------------------------------------
if __name__ == "__main__":
    app.run(
        debug=True,
        host="127.0.0.1",
        port=5000
    )
