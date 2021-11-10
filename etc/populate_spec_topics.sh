#! /usr/bin/env bash

if [[ -z $MONGODB_SPECIFICATIONS_DIRECTORY ]]; then
    tmpdir=$(mktemp -d -t spec_testsXXXX)
    curl -sL "https://github.com/mongodb/specifications/archive/master.zip" -o "$tmpdir/specs.zip"
    unzip -d "$tmpdir" "$tmpdir/specs.zip" > /dev/null
    MONGODB_SPECIFICATIONS_DIRECTORY="$tmpdir"/specifications-master
fi

SPEC_TOPICS=$(find "$MONGODB_SPECIFICATIONS_DIRECTORY"/source -maxdepth 1 -type d -exec basename {} + | sort)

for TOPIC in $SPEC_TOPICS
do
    if [[ $TOPIC == ".DS_Store" ]]; then continue; fi
    if [[ $TOPIC == "Makefile" ]]; then continue; fi
    if [[ $TOPIC == "source" ]]; then continue; fi

    if [[ $TOPIC == *".rst" ]]; then
        TOPIC=$(echo "$TOPIC" | cut -f1 -d'.')
    fi

    echo "$TOPIC"
    mkdir -p "test/integration/$TOPIC"
    touch "test/integration/$TOPIC/.gitkeep"
done
