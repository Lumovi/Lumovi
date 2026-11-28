// How Helm 3 and the cluster's reader before apimachinery 0.21 cut a manifest into documents,
// for tests/web/helm-diff.spec.ts: `go run . splits.json` (then Prettier on it) rewrites each
// entry's "helm3" and "cluster" from its "text".
//
// SplitManifests is Helm 3.22.1's (pkg/releaseutil/manifest.go), copyright The Helm Authors;
// YAMLReader and LineReader are apimachinery v0.20.1's (pkg/util/yaml/decoder.go), copyright The
// Kubernetes Authors; both copied as they are, under the Apache License, Version 2.0
// (http://www.apache.org/licenses/LICENSE-2.0).
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"unicode"
)

var _ = unicode.IsSpace

var sep = regexp.MustCompile("(?:^|\\s*\n)---\\s*")

// SplitManifests takes a string of manifest and returns a map contains individual manifests
func SplitManifests(bigFile string) map[string]string {
	// Basically, we're quickly splitting a stream of YAML documents into an
	// array of YAML docs. The file name is just a place holder, but should be
	// integer-sortable so that manifests get output in the same order as the
	// input (see `BySplitManifestsOrder`).
	tpl := "manifest-%d"
	res := map[string]string{}
	// Making sure that any extra whitespace in YAML stream doesn't interfere in splitting documents correctly.
	bigFileTmp := strings.TrimSpace(bigFile)
	docs := sep.Split(bigFileTmp, -1)
	var count int
	for _, d := range docs {
		if d == "" {
			continue
		}

		d = strings.TrimSpace(d)
		res[fmt.Sprintf(tpl, count)] = d
		count = count + 1
	}
	return res
}

const separator = "---"

type Reader interface {
	Read() ([]byte, error)
}
type YAMLReader struct {
	reader Reader
}

func NewYAMLReader(r *bufio.Reader) *YAMLReader {
	return &YAMLReader{
		reader: &LineReader{reader: r},
	}
}
func (r *YAMLReader) Read() ([]byte, error) {
	var buffer bytes.Buffer
	for {
		line, err := r.reader.Read()
		if err != nil && err != io.EOF {
			return nil, err
		}

		sep := len([]byte(separator))
		if i := bytes.Index(line, []byte(separator)); i == 0 {
			// We have a potential document terminator
			i += sep
			after := line[i:]
			if len(strings.TrimRightFunc(string(after), unicode.IsSpace)) == 0 {
				if buffer.Len() != 0 {
					return buffer.Bytes(), nil
				}
				if err == io.EOF {
					return nil, err
				}
			}
		}
		if err == io.EOF {
			if buffer.Len() != 0 {
				// If we're at EOF, we have a final, non-terminated line. Return it.
				return buffer.Bytes(), nil
			}
			return nil, err
		}
		buffer.Write(line)
	}
}

type LineReader struct {
	reader *bufio.Reader
}

func (r *LineReader) Read() ([]byte, error) {
	var (
		isPrefix bool  = true
		err      error = nil
		line     []byte
		buffer   bytes.Buffer
	)

	for isPrefix && err == nil {
		line, isPrefix, err = r.reader.ReadLine()
		buffer.Write(line)
	}
	buffer.WriteByte('\n')
	return buffer.Bytes(), err
}

type entry struct {
	Text    string   `json:"text"`
	Helm3   []string `json:"helm3"`
	Cluster []string `json:"cluster"`
}

func main() {
	file := os.Args[1]
	data, err := os.ReadFile(file)
	if err != nil {
		panic(err)
	}
	var entries []entry
	if err := json.Unmarshal(data, &entries); err != nil {
		panic(err)
	}
	out := []entry{}
	for _, e := range entries {
		text := e.Text
		pieces := SplitManifests(text)
		r := entry{Text: text, Helm3: []string{}, Cluster: []string{}}
		for i := 0; i < len(pieces); i++ {
			r.Helm3 = append(r.Helm3, pieces[fmt.Sprintf("manifest-%d", i)])
		}
		reader := NewYAMLReader(bufio.NewReader(strings.NewReader(text)))
		for {
			chunk, err := reader.Read()
			if err == io.EOF {
				break
			}
			if err != nil {
				r.Cluster = nil
				break
			}
			r.Cluster = append(r.Cluster, string(chunk))
		}
		out = append(out, r)
	}
	_ = bytes.MinRead
	written, err := json.MarshalIndent(out, "", " ")
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(file, append(written, '\n'), 0o644); err != nil {
		panic(err)
	}
}
